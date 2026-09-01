// server/api/admin/cache.get.ts
// 缓存管理(管理端):跨用户世界缓存(world_cache)列表,支持按标题/作者/特征码搜索、排序与分页(每页 20)。
// 拉取命中同一 (sourceHash, mode) 共享一份成书,此页用于排查缓存命中问题与清理过期条目。
import { useD1 } from '../../utils/d1'
import { requireAdmin } from '../../utils/authz'
import { worldCache } from '../../db/schema'
import { desc, asc, count, eq, like, or, and, sql } from 'drizzle-orm'

const SORT_FIELDS = ['createdAt', 'updatedAt', 'downloads', 'tokensUsed'] as const
type SortField = typeof SORT_FIELDS[number]

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const query = getQuery<{ page?: string, pageSize?: string, sort?: string, dir?: string, q?: string, mode?: string }>(event)

  const page = Math.max(1, Math.floor(Number(query.page ?? 1)) || 1)
  const pageSize = 20 // 固定每页 20 条
  const sort: SortField = (SORT_FIELDS as readonly string[]).includes(query.sort ?? '')
    ? query.sort as SortField
    : 'createdAt'
  const dir = query.dir === 'asc' ? 'asc' : 'desc'
  const q = String(query.q ?? '').trim().slice(0, 100).replace(/[%_\\]/g, '')
  const mode = query.mode === 'eco' || query.mode === 'full' ? query.mode : undefined

  // 组合筛选:关键词(标题/作者/特征码前缀)+ 模式(full/eco)
  const conds = [
    mode ? eq(worldCache.mode, mode) : undefined,
    q
      ? or(
          like(worldCache.title, `%${q}%`),
          like(worldCache.author, `%${q}%`),
          like(worldCache.sourceHash, `%${q}%`)
        )
      : undefined
  ].filter((c): c is NonNullable<typeof c> => !!c)

  const orderBy = dir === 'asc'
    ? asc(sort === 'createdAt' ? worldCache.createdAt : sort === 'updatedAt' ? worldCache.updatedAt : sort === 'downloads' ? worldCache.downloads : worldCache.tokensUsed)
    : desc(sort === 'createdAt' ? worldCache.createdAt : sort === 'updatedAt' ? worldCache.updatedAt : sort === 'downloads' ? worldCache.downloads : worldCache.tokensUsed)

  const total = conds.length
    ? await db.select({ n: count() }).from(worldCache).where(and(...conds)).all()
    : await db.select({ n: count() }).from(worldCache).all()

  const rows = await db.select()
    .from(worldCache)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  // 汇总统计:缓存总数 / 拉取总次数 / 成书总消耗(排查命中问题时一眼看全站缓存规模)
  const summary = await db.select({
    totalCache: count(),
    totalDownloads: sql<number>`COALESCE(SUM(${worldCache.downloads}), 0)`,
    totalTokens: sql<number>`COALESCE(SUM(${worldCache.tokensUsed}), 0)`
  }).from(worldCache).all()

  return {
    rows: rows.map(r => ({
      id: r.id,
      sourceHash: r.sourceHash,
      mode: r.mode,
      fileSize: r.fileSize,
      title: r.title,
      author: r.author,
      worldKey: r.worldKey,
      tokensUsed: r.tokensUsed,
      downloads: r.downloads,
      createdBy: r.createdBy,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt)
    })),
    total: total[0]?.n ?? 0,
    page,
    pageSize,
    sort,
    dir,
    q,
    mode,
    stats: {
      totalCache: summary[0]?.totalCache ?? 0,
      totalDownloads: summary[0]?.totalDownloads ?? 0,
      totalTokens: summary[0]?.totalTokens ?? 0
    }
  }
})
