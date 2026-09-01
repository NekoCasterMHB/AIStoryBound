// server/api/admin/cache/[id].delete.ts
// 缓存管理(管理端):删除单条跨用户世界缓存。
// 操作:删 world_cache 行 + 删对应 R2 成书文件(world-cache/<hash>-<mode>.json)。
// R2 文件被其他相同 (hash, mode) 的任务行引用时也会一并删除——该 key 由内容决定,
// 删除后如需拉取需重新生成,属管理端显式清理行为;原文源文件(world-gen/sources)不受影响。
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { worldCache } from '../../../db/schema'
import { getSkillBucket } from '../../../utils/r2'
import { eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少缓存 id' })

  const db = useD1(event)
  const row = await db.select().from(worldCache).where(eq(worldCache.id, id)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '缓存不存在或已被清理' })

  // 删 R2 成书文件(best-effort;R2 不存在时忽略)
  if (row.worldKey) {
    try {
      await getSkillBucket(event).delete(row.worldKey)
    } catch (e) {
      console.error('[admin/cache] 删除 R2 成书文件失败', { id, worldKey: row.worldKey }, e)
    }
  }

  await db.delete(worldCache).where(eq(worldCache.id, id)).run()
  return { ok: true, id, title: row.title, mode: row.mode }
})
