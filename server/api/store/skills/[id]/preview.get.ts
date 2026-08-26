// server/api/store/skills/[id]/preview.get.ts
// Skill 在线预览(公开,游客可访问):读取最新已上架版本的压缩包,返回文件清单与 markdown 文本内容。
// 权限:免费商品 / 已购买 / 发布者 / 管理员可看全部 markdown;未付费游客仅可看 README 摘要
// (主表 readme 字段,SKILL.md 正文脱标记截断,不返回 SKILL.md 文件本身)。
// 限制:最多 30 个 md、单个 ≤200KB、合计 ≤1MB,超限跳过,防止大包拖垮接口。
import { unzipSync } from 'fflate'
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { getSessionUser, isAdmin } from '../../../../utils/authz'
import { skillProducts, skillProductVersions, skillPurchases } from '../../../../db/schema'
import { and, eq, desc } from 'drizzle-orm'

const MAX_MD_FILES = 30
const MAX_MD_BYTES = 200 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024

export default defineEventHandler(async (event) => {
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 Skill id' })

  const rows = await db.select().from(skillProducts).where(eq(skillProducts.id, id)).all()
  const skill = rows[0]
  if (!skill) throw createError({ statusCode: 404, statusMessage: 'Skill 不存在' })

  // 预览对象 = 最新已上架版本
  const saleRows = await db.select({ fileKey: skillProductVersions.fileKey })
    .from(skillProductVersions)
    .where(and(eq(skillProductVersions.skillId, id), eq(skillProductVersions.status, 'approved')))
    .orderBy(desc(skillProductVersions.version))
    .limit(1)
    .all()
  const saleRow = saleRows[0]
  if (!saleRow) throw createError({ statusCode: 404, statusMessage: '该 Skill 暂无已上架版本' })

  // 权限:免费商品直接解锁;登录用户按 发布者/管理员/已购买 判定
  let canViewAll = skill.price === 0
  const sessionUser = await getSessionUser(event)
  if (sessionUser && !canViewAll) {
    if (skill.sellerId === sessionUser.id || await isAdmin(event, sessionUser)) {
      canViewAll = true
    } else {
      const owned = await db.select({ id: skillPurchases.id })
        .from(skillPurchases)
        .where(and(eq(skillPurchases.skillId, id), eq(skillPurchases.buyerId, sessionUser.id)))
        .all()
      canViewAll = owned.length > 0
    }
  }

  const object = await getSkillBucket(event).get(saleRow.fileKey)
  if (!object) {
    throw createError({ statusCode: 404, statusMessage: 'Skill 文件不存在或已被删除' })
  }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(await object.arrayBuffer()))
  } catch {
    throw createError({ statusCode: 400, statusMessage: '压缩包解析失败,无法预览' })
  }

  const names = Object.keys(files).sort()
  const entries = names.map((name) => {
    const bytes = files[name] ?? new Uint8Array(0)
    return { name, size: bytes.length, isDirectory: name.endsWith('/') || bytes.length === 0 }
  })

  const decoder = new TextDecoder()
  const mds: { name: string, content: string }[] = []
  let totalBytes = 0
  for (const name of names) {
    const bytes = files[name]
    if (!bytes || bytes.length === 0) continue
    if (mds.length >= MAX_MD_FILES || totalBytes >= MAX_TOTAL_BYTES) break
    if (!/\.(md|markdown)$/i.test(name)) continue
    if (bytes.length > MAX_MD_BYTES) continue
    mds.push({ name, content: decoder.decode(bytes) })
    totalBytes += bytes.length
  }

  // 未付费仅开放 README 摘要(SKILL.md 正文脱标记截断,不暴露 frontmatter 与其余文件);
  // 免费 / 已购买 / 发布者 / 管理员返回全部 markdown 文件
  const visible = canViewAll ? mds : []

  return {
    name: skill.name,
    price: skill.price,
    canViewAll,
    /** 未付费可读的 README 摘要(主表快照,收录时强制非空;老数据可能为空) */
    readme: skill.readme ?? '',
    entries,
    files: visible
  }
})
