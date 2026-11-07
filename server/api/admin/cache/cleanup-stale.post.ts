// server/api/admin/cache/cleanup-stale.post.ts
// 缓存管理(管理端):一键清理 60 天未拉取(updatedAt 距今超过 60 天)的旧缓存。
// 与单条删除同语义:删 world_cache 行 + 删对应 R2 成书文件(world-cache/<hash>-<mode>.json)。
// 注意:历史拉取任务的 resultKey 指向同一 R2 对象(key 由内容决定),删除后这些任务
// 的成书下载将 404,属管理端显式清理行为;原文源文件(world-gen/sources)不受影响。
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { worldCache } from '../../../db/schema'
import { getSkillBucket } from '../../../utils/r2'
import { inArray, lt } from 'drizzle-orm'

/** 旧缓存判定阈值(天):cache.get.ts 的 staleCache 统计与前端文案依赖此值,改动需三处同步 */
const STALE_DAYS = 60

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000)

  // 先取候选行拿 R2 key,再删行删文件;updatedAt 在每次拉取命中时刷新,60 天未更新即 60 天无人拉取
  const rows = await db.select({ id: worldCache.id, worldKey: worldCache.worldKey })
    .from(worldCache)
    .where(lt(worldCache.updatedAt, cutoff))
    .all()

  if (rows.length) {
    // 批量删 R2 成书文件(best-effort;binding 单次最多 1000 个 key,按 900 分批;R2 不存在时忽略)
    const keys = [...new Set(rows.map(r => r.worldKey).filter(Boolean))]
    for (let i = 0; i < keys.length; i += 900) {
      try {
        await getSkillBucket(event).delete(keys.slice(i, i + 900))
      } catch (e) {
        console.error('[admin/cache] 批量删除 R2 成书文件失败', { batch: Math.floor(i / 900), total: keys.length }, e)
      }
    }

    // 删库行(按 100 分批,规避 D1 单查询绑定变量上限)
    const ids = rows.map(r => r.id)
    for (let i = 0; i < ids.length; i += 100) {
      await db.delete(worldCache).where(inArray(worldCache.id, ids.slice(i, i + 100))).run()
    }
  }

  return { ok: true, deleted: rows.length, staleDays: STALE_DAYS, cutoffAt: cutoff.getTime() }
})
