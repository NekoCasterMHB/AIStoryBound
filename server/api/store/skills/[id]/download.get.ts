// server/api/store/skills/[id]/download.get.ts
// Skill 压缩包下载(按版本):?version= 指定版本号,不传则取默认版本 —
//   管理员 / 发布者:默认最新版本,可下载任意版本;
//   已购买者:默认购买时锁定的版本,可下载该版本及该商品所有已上架(approved)版本。
// 从 R2 流式返回 zip,带附件头,并累加下载计数。
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { requireUser, isAdmin } from '../../../../utils/authz'
import { skillProducts, skillProductVersions, skillPurchases } from '../../../../db/schema'
import { and, eq, desc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const currentUser = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 Skill id' })

  const rows = await db.select().from(skillProducts).where(eq(skillProducts.id, id)).all()
  const skill = rows[0]
  if (!skill) throw createError({ statusCode: 404, statusMessage: 'Skill 不存在' })

  const admin = await isAdmin(event, currentUser)
  const isSeller = skill.sellerId === currentUser.id

  // 已购买记录(含锁定版本),仅购买者查询
  let lockedVersionId: string | null = null
  if (!admin && !isSeller) {
    const pRows = await db.select({ skillVersionId: skillPurchases.skillVersionId })
      .from(skillPurchases)
      .where(and(eq(skillPurchases.skillId, id), eq(skillPurchases.buyerId, currentUser.id)))
      .all()
    const pRow = pRows[0]
    if (!pRow) {
      throw createError({ statusCode: 403, statusMessage: '请先购买该 Skill 后再下载' })
    }
    lockedVersionId = pRow.skillVersionId
  }

  // 全部版本(供权限判定与默认版本选择)
  const allVersions = await db.select({
    id: skillProductVersions.id,
    version: skillProductVersions.version,
    status: skillProductVersions.status,
    fileKey: skillProductVersions.fileKey,
    fileName: skillProductVersions.fileName
  })
    .from(skillProductVersions)
    .where(eq(skillProductVersions.skillId, id))
    .orderBy(desc(skillProductVersions.version))
    .all()
  if (allVersions.length === 0) throw createError({ statusCode: 404, statusMessage: '该 Skill 还没有任何版本' })

  const want = Number(getQuery(event).version)
  let target: (typeof allVersions)[number] | null = null

  if (Number.isInteger(want)) {
    target = allVersions.find(v => v.version === want) ?? null
    if (!target) throw createError({ statusCode: 404, statusMessage: `版本 v${want} 不存在` })
    // 权限:购买者仅可下载锁定版本与该商品已上架版本
    if (!admin && !isSeller) {
      const allowed = target.id === lockedVersionId
        || target.status === 'approved'
        || (lockedVersionId === null && target.version === 1)
      if (!allowed) {
        throw createError({ statusCode: 403, statusMessage: '该版本不可下载(仅可下载购买版本与已上架版本)' })
      }
    }
  } else {
    // 默认版本:发布者/管理员取最新;购买者取购买锁定版本(旧记录无锁定时退化为 v1)
    if (!admin && !isSeller) {
      target = allVersions.find(v => v.id === lockedVersionId)
        ?? allVersions.find(v => v.version === 1)
        ?? null
    }
    target = target ?? allVersions[0] ?? null
  }
  if (!target) throw createError({ statusCode: 404, statusMessage: '该 Skill 还没有任何版本' })

  const object = await getSkillBucket(event).get(target.fileKey)
  if (!object) {
    throw createError({ statusCode: 404, statusMessage: 'Skill 文件不存在或已被删除' })
  }

  // 下载计数(失败不影响下载)
  await db.update(skillProducts)
    .set({ downloadCount: sql`${skillProducts.downloadCount} + 1` })
    .where(eq(skillProducts.id, id))
    .run()
    .catch(() => {})

  const plainName = (target.fileName || skill.name || 'skill').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\.zip$/i, '') + `-v${target.version}.zip`
  const asciiName = /^[\x20-\x7E]*$/.test(plainName) ? plainName : `skill-v${target.version}.zip`
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(plainName)}`,
    'Cache-Control': 'private, max-age=60'
  })
  return new Response(object.body)
})