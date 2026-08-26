// server/api/store/skills.post.ts
// 发布/更新 Skill(multipart 表单):name / tags / price / file(zip 压缩包),可选 skillId=更新模式。
// 首次发布:创建商品主表(status=pending)+ 版本 v1,均为待审核。
// 更新:在原商品下追加新版本(版本号自动递增,独立 R2 文件,旧文件保留),新版本待审核;
//      审核通过前商店继续售卖旧版本(主表保持原在售快照,通过后由审核接口同步)。
// 校验:zip 真实可解压且含 SKILL.md(市面通用 agent skill 格式,见 shared/store-skill.ts)。
import { readMultipartFormData } from 'h3'
import { useD1 } from '../../utils/d1'
import { getSkillBucket } from '../../utils/r2'
import { requireUser } from '../../utils/authz'
import { skillProducts, skillProductVersions } from '../../db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { uuid } from '../../../shared/novel'
import {
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_TAGS,
  MAX_SKILL_ZIP_BYTES,
  SKILL_ZIP_EXTENSIONS,
  parseSkillZip,
  extractSkillMeta,
  parseTagsInput
} from '../../../shared/store-skill'

const textOf = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array())

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useD1(event)
  const bucket = getSkillBucket(event)

  const parts = await readMultipartFormData(event)
  if (!parts) throw createError({ statusCode: 400, statusMessage: '请提交完整的发布表单' })

  const name = textOf(parts.find(p => p.name === 'name')?.data).trim()
  // desc 为旧接口字段(说明文);新表单只提交 tags,desc 缺失时由标签串派生,保证老展示/管理端仍有文本
  const descRaw = textOf(parts.find(p => p.name === 'desc')?.data).trim()
  const formTags = parseTagsInput(textOf(parts.find(p => p.name === 'tags')?.data))
  let price = Math.floor(Number(textOf(parts.find(p => p.name === 'price')?.data)))
  const skillId = textOf(parts.find(p => p.name === 'skillId')?.data).trim()
  const filePart = parts.find(p => p.name === 'file' && !!p.filename)

  if (!name || name.length > MAX_SKILL_NAME_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `Skill 名称需在 1~${MAX_SKILL_NAME_CHARS} 字之间` })
  }
  if (!Number.isFinite(price) || price < 0) {
    throw createError({ statusCode: 400, statusMessage: '售价需为不小于 0 的整数 token(0 表示免费)' })
  }
  const fileName = filePart?.filename ?? ''
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (!SKILL_ZIP_EXTENSIONS.includes(ext)) {
    throw createError({ statusCode: 400, statusMessage: '请上传 .zip 压缩包' })
  }
  const fileData = filePart?.data
  if (!fileData || fileData.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '压缩包内容为空' })
  }
  if (fileData.length > MAX_SKILL_ZIP_BYTES) {
    throw createError({ statusCode: 400, statusMessage: `压缩包超过 ${MAX_SKILL_ZIP_BYTES / 1024 / 1024}MB 上限` })
  }

  // zip 校验:可解压 + 含 SKILL.md,产出文件清单供管理端预览、SKILL.md 文本用于展示元数据
  let entries
  let skillMd
  try {
    const parsed = parseSkillZip(fileData)
    entries = parsed.entries
    skillMd = parsed.skillMd
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: (e as Error).message })
  }
  // 展示元数据:frontmatter 的 icon/tags + 正文摘要;SKILL.md 正文为必填(未付费预览依赖 readme)
  const { icon, tags: fmTags, readme } = extractSkillMeta(skillMd ?? '')
  if (!readme) {
    throw createError({ statusCode: 400, statusMessage: '压缩包内的 SKILL.md 缺少正文(readme):请在 frontmatter 之后写明玩法步骤与规则,未付费用户将以此内容预览商品' })
  }
  // 标签 = 表单输入 + SKILL.md frontmatter 合并去重(最多 6 个);说明文 = 旧接口 desc 或标签串
  const tags = [...formTags]
  for (const t of fmTags) {
    if (tags.length >= MAX_SKILL_TAGS) break
    if (!tags.includes(t)) tags.push(t)
  }
  const desc = descRaw || tags.join('、')

  // 更新模式:校验商品归属,版本号自动递增,售价沿用主表当前值(更新不允许变更售价)
  let productId: string
  let version: number
  if (skillId) {
    const rows = await db.select({ id: skillProducts.id, price: skillProducts.price })
      .from(skillProducts)
      .where(and(eq(skillProducts.id, skillId), eq(skillProducts.sellerId, user.id)))
      .all()
    const row = rows[0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'Skill 不存在或不属于你' })
    }
    productId = skillId
    price = row.price
    const maxRow = await db.select({ m: sql<number>`max(${skillProductVersions.version})` })
      .from(skillProductVersions)
      .where(eq(skillProductVersions.skillId, skillId))
      .all()
    version = (maxRow[0]?.m ?? 0) + 1
  } else {
    productId = uuid()
    version = 1
  }

  const fileKey = version === 1
    ? `skills/${user.id}/${productId}.zip`
    : `skills/${user.id}/${productId}-v${version}.zip`
  await bucket.put(fileKey, fileData, {
    httpMetadata: { contentType: 'application/zip' }
  })

  const now = new Date()
  if (version === 1) {
    await db.insert(skillProducts).values({
      id: productId,
      sellerId: user.id,
      name,
      desc,
      price,
      fileKey,
      fileName,
      fileSize: fileData.length,
      fileEntries: JSON.stringify(entries.slice(0, 200)),
      icon,
      tags: tags.length ? JSON.stringify(tags) : null,
      readme,
      status: 'pending',
      featured: 0,
      downloadCount: 0,
      purchaseCount: 0,
      createdAt: now,
      updatedAt: now
    }).run()
  }

  await db.insert(skillProductVersions).values({
    id: uuid(),
    skillId: productId,
    version,
    name,
    desc,
    price,
    fileKey,
    fileName,
    fileSize: fileData.length,
    fileEntries: JSON.stringify(entries.slice(0, 200)),
    icon,
    tags: tags.length ? JSON.stringify(tags) : null,
    readme,
    status: 'pending',
    createdAt: now
  }).run()

  return { ok: true, id: productId, version, status: 'pending' }
})
