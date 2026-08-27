// server/api/admin/skills/publish.post.ts
// 管理员直接发布/更新 Skill(multipart 表单:name / price / tags / file(zip),可选 skillId=更新模式)。
// 与商城发布接口(store/skills.post.ts)相同的表单与 zip 校验,但直接以 approved 上架(跳过审核队列):
// 首次发布 = 主表 + v1 均 approved;更新 = 版本递增且新版本直接通过并同步主表为在售快照。
import { readMultipartFormData } from 'h3'
import { useD1 } from '../../../utils/d1'
import { getSkillBucket } from '../../../utils/r2'
import { requireAdmin } from '../../../utils/authz'
import { skillProducts, skillProductVersions } from '../../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { uuid } from '../../../../shared/novel'
import {
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_TAGS,
  MAX_SKILL_ZIP_BYTES,
  SKILL_ZIP_EXTENSIONS,
  parseSkillZip,
  extractSkillMeta,
  parseTagsInput
} from '../../../../shared/store-skill'

const textOf = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array())

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const db = useD1(event)
  const bucket = getSkillBucket(event)

  const parts = await readMultipartFormData(event)
  if (!parts) throw createError({ statusCode: 400, statusMessage: '请提交完整的发布表单' })

  const name = textOf(parts.find(p => p.name === 'name')?.data).trim()
  const descRaw = textOf(parts.find(p => p.name === 'desc')?.data).trim()
  const formTags = parseTagsInput(textOf(parts.find(p => p.name === 'tags')?.data))
  const price = Math.floor(Number(textOf(parts.find(p => p.name === 'price')?.data)))
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

  // zip 校验:可解压 + 含 SKILL.md + 含 README(商城说明区展示)
  let entries
  let skillMd
  let readmeFile
  try {
    const parsed = parseSkillZip(fileData)
    entries = parsed.entries
    skillMd = parsed.skillMd
    readmeFile = parsed.readmeFile
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: (e as Error).message })
  }
  if (!readmeFile?.trim()) {
    throw createError({ statusCode: 400, statusMessage: '压缩包缺少 README 文件(如 README.md):商城说明区域将展示 README 内容' })
  }
  const { icon, tags: fmTags, readme } = extractSkillMeta(skillMd ?? '', readmeFile)
  if (!readme) {
    throw createError({ statusCode: 400, statusMessage: '压缩包内的 README 内容为空:请在 README 中写明玩法说明' })
  }
  const tags = [...formTags]
  for (const t of fmTags) {
    if (tags.length >= MAX_SKILL_TAGS) break
    if (!tags.includes(t)) tags.push(t)
  }
  const desc = descRaw || tags.join('、')

  // 更新模式:任意已存在商品(管理员可更新任何商品),版本递增,可直接改价
  let productId: string
  let version: number
  if (skillId) {
    const rows = await db.select({ id: skillProducts.id }).from(skillProducts).where(eq(skillProducts.id, skillId)).all()
    if (!rows[0]) {
      throw createError({ statusCode: 404, statusMessage: 'Skill 不存在' })
    }
    productId = skillId
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
    ? `skills/${admin.id}/${productId}.zip`
    : `skills/${admin.id}/${productId}-v${version}.zip`
  await bucket.put(fileKey, fileData, {
    httpMetadata: { contentType: 'application/zip' }
  })

  const now = new Date()
  const entriesJson = JSON.stringify(entries.slice(0, 200))
  const tagsJson = tags.length ? JSON.stringify(tags) : null

  if (version === 1) {
    await db.insert(skillProducts).values({
      id: productId,
      sellerId: admin.id,
      name,
      desc,
      price,
      fileKey,
      fileName,
      fileSize: fileData.length,
      fileEntries: entriesJson,
      icon,
      tags: tagsJson,
      readme,
      status: 'approved',
      mainVersion: 1,
      featured: 0,
      downloadCount: 0,
      purchaseCount: 0,
      reviewedBy: admin.id,
      reviewedAt: now,
      createdAt: now,
      updatedAt: now
    }).run()
  } else {
    // 更新模式:新版本直接通过 → 同步主表为新的在售快照
    await db.update(skillProducts)
      .set({
        name,
        desc,
        price,
        fileKey,
        fileName,
        fileSize: fileData.length,
        fileEntries: entriesJson,
        icon,
        tags: tagsJson,
        readme,
        status: 'approved',
        mainVersion: version,
        reviewedBy: admin.id,
        reviewedAt: now,
        updatedAt: now
      })
      .where(eq(skillProducts.id, productId))
      .run()
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
    fileEntries: entriesJson,
    icon,
    tags: tagsJson,
    readme,
    status: 'approved',
    reviewedBy: admin.id,
    reviewedAt: now,
    createdAt: now
  }).run()

  return { ok: true, id: productId, version, status: 'approved' }
})
