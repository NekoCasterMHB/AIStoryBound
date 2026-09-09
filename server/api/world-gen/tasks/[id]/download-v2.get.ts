// server/api/world-gen/tasks/[id]/download-v2.get.ts
// 下载云端成书的 v2(aisb-book)产物 zip(finalize 打包存 R2;旧任务无 v2 产物时 404,
// 客户端据此回退 v1 下载)。文件为作品格式 v2 目录 zip:manifest.json + <书名>.txt + segments/ + characters/。
import { and, eq, sql } from 'drizzle-orm'
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { worldCache, worldGenTasks } from '../../../../db/schema'
import { getSkillBucket } from '../../../../utils/r2'
import { book2CacheObjectKey } from '../../../../utils/world-gen-pipeline'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少任务 id' })
  const db = useD1(event)
  const row = await db.select()
    .from(worldGenTasks)
    .where(and(eq(worldGenTasks.id, id), eq(worldGenTasks.userId, sessUser.id)))
    .get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '任务不存在' })
  if (row.status !== 'completed') {
    throw createError({ statusCode: 409, statusMessage: '任务尚未完成,无法下载' })
  }

  const bucket = getSkillBucket(event)
  const key = book2CacheObjectKey(row.sourceHash, row.mode)
  const obj = await bucket.get(key)
  if (!obj) throw createError({ statusCode: 404, statusMessage: '该任务没有 v2 产物' })

  // 下载计数(best-effort,不阻塞下载;与 v1 下载端点口径一致:
  // update 带 (hash, mode) 条件,自定义模式不在共享缓存表时零行命中自然跳过)
  try {
    await db.update(worldCache)
      .set({ downloads: sql`${worldCache.downloads} + 1`, updatedAt: new Date() })
      .where(and(eq(worldCache.sourceHash, row.sourceHash), eq(worldCache.mode, row.mode)))
      .run()
  } catch {
    // 计数失败不影响下载
  }

  const safeName = (row.title || 'world').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'world'
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(`${safeName}.book2.zip`)}"; filename*=UTF-8''${encodeURIComponent(`${safeName}.book2.zip`)}`,
    'Cache-Control': 'no-store'
  })
  return new Response(await obj.arrayBuffer() as unknown as BodyInit)
})
