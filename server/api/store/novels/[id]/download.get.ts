// server/api/store/novels/[id]/download.get.ts
// 小说 TXT 下载(按版本):?version= 指定版本号,不传则取默认版本 —
//   管理员 / 发布者:默认最新版本,可下载任意版本;
//   已购买者:默认购买时锁定的版本,可下载该版本及该商品所有已上架(approved)版本。
// 从 R2 流式返回 txt,带附件头,并累加下载计数。
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { requireUser, isAdmin } from '../../../../utils/authz'
import { novelProducts, novelProductVersions, novelPurchases } from '../../../../db/schema'
import { and, eq, desc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const currentUser = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少小说 id' })

  const rows = await db.select().from(novelProducts).where(eq(novelProducts.id, id)).all()
  const novel = rows[0]
  if (!novel) throw createError({ statusCode: 404, statusMessage: '小说不存在' })

  const admin = await isAdmin(event, currentUser)
  const isSeller = novel.sellerId === currentUser.id

  // 已购买记录(含锁定版本),仅购买者查询
  let lockedVersionId: string | null = null
  if (!admin && !isSeller) {
    const pRows = await db.select({ novelVersionId: novelPurchases.novelVersionId })
      .from(novelPurchases)
      .where(and(eq(novelPurchases.novelId, id), eq(novelPurchases.buyerId, currentUser.id)))
      .all()
    const pRow = pRows[0]
    if (!pRow) {
      throw createError({ statusCode: 403, statusMessage: '请先购买该小说后再下载' })
    }
    lockedVersionId = pRow.novelVersionId
  }

  // 全部版本(供权限判定与默认版本选择)
  const allVersions = await db.select({
    id: novelProductVersions.id,
    version: novelProductVersions.version,
    status: novelProductVersions.status,
    enabled: novelProductVersions.enabled,
    fileKey: novelProductVersions.fileKey,
    fileName: novelProductVersions.fileName
  })
    .from(novelProductVersions)
    .where(eq(novelProductVersions.novelId, id))
    .orderBy(desc(novelProductVersions.version))
    .all()
  if (allVersions.length === 0) throw createError({ statusCode: 404, statusMessage: '该小说还没有任何版本' })

  const want = Number(getQuery(event).version)
  let target: (typeof allVersions)[number] | null = null

  if (Number.isInteger(want)) {
    target = allVersions.find(v => v.version === want) ?? null
    if (!target) throw createError({ statusCode: 404, statusMessage: `版本 v${want} 不存在` })
    // 权限:购买者仅可下载锁定版本与该商品已上架且启用的版本(禁用版本用户侧不提供)
    if (!admin && !isSeller) {
      const allowed = target.id === lockedVersionId
        || (target.status === 'approved' && target.enabled === 1)
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
  if (!target) throw createError({ statusCode: 404, statusMessage: '该小说还没有任何版本' })

  const object = await getSkillBucket(event).get(target.fileKey)
  if (!object) {
    throw createError({ statusCode: 404, statusMessage: '小说文件不存在或已被删除' })
  }

  // 下载计数(失败不影响下载)
  await db.update(novelProducts)
    .set({ downloadCount: sql`${novelProducts.downloadCount} + 1` })
    .where(eq(novelProducts.id, id))
    .run()
    .catch(() => {})

  const plainName = (target.fileName || novel.title || 'novel').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\.(txt|text)$/i, '') + `-v${target.version}.txt`
  const asciiName = /^[\x20-\x7E]*$/.test(plainName) ? plainName : `novel-v${target.version}.txt`
  setResponseHeaders(event, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(plainName)}`,
    'Cache-Control': 'private, max-age=60'
  })
  return new Response(object.body)
})
