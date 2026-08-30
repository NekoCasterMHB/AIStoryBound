// server/api/world-gen/tasks/[id]/download.get.ts
// 下载云端成书 zip(fflate 按需打包,不在 R2 存副本):
//   manifest.json(aisb-share 格式)+ work.json(完整 LocalWork,含正文与生成产物)+ story.txt(原文)。
// 客户端用现有 importWorkFromZip 逻辑即可直接安装进 IndexedDB 书架。
import { and, eq, sql } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { worldCache, worldGenTasks } from '../../../../db/schema'
import { getSkillBucket } from '../../../../utils/r2'
import { SHARE_FORMAT, SHARE_VERSION } from '../../../../../shared/share-format'

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
  if (row.status !== 'completed' || !row.resultKey) {
    throw createError({ statusCode: 409, statusMessage: '任务尚未完成,无法下载' })
  }

  const bucket = getSkillBucket(event)
  const worldObj = await bucket.get(row.resultKey)
  if (!worldObj) throw createError({ statusCode: 410, statusMessage: '成书缓存缺失,请重新生成' })
  let world: { title?: string, author?: string | null, overlay?: { title?: string, summary?: string }, entities?: unknown, conflicts?: unknown, storyline?: unknown, warnings?: string[], tokensUsed?: number, mode?: string }
  try {
    world = JSON.parse(await worldObj.text()) as typeof world
  } catch {
    throw createError({ statusCode: 410, statusMessage: '成书缓存损坏,请重新生成' })
  }

  // 原文(拉取的任务同样可下;源文件按 hash 全站共享存储)
  const sourceObj = await bucket.get(row.sourceKey)
  if (!sourceObj) throw createError({ statusCode: 410, statusMessage: '原文缺失,无法打包' })
  const text = await sourceObj.text()

  const title = world.title || row.title || '未命名'
  const now = new Date().toISOString()
  const work = {
    id: row.id,
    title,
    author: world.author ?? row.author ?? undefined,
    createdAt: now,
    updatedAt: now,
    chapters: [{ title: '', content: text }],
    encoding: row.encoding ?? undefined,
    syncStatus: 'local' as const,
    tokensUsed: world.tokensUsed ?? row.tokensUsed,
    entities: world.entities,
    conflicts: world.conflicts,
    warnings: world.warnings ?? [],
    overlay: world.overlay,
    storyline: world.storyline
  }
  const manifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    kind: 'game' as const,
    title,
    exportedAt: now,
    includes: ['work.json', 'story.txt']
  }
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'work.json': strToU8(JSON.stringify(work)),
    'story.txt': strToU8(text)
  }, { level: 6 })

  // 下载计数(best-effort,不阻塞下载)
  try {
    await db.update(worldCache)
      .set({ downloads: sql`${worldCache.downloads} + 1`, updatedAt: new Date() })
      .where(and(eq(worldCache.sourceHash, row.sourceHash), eq(worldCache.mode, row.mode)))
      .run()
  } catch {
    // 计数失败不影响下载
  }

  const safeName = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'world'
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(`${safeName}.zip`)}"; filename*=UTF-8''${encodeURIComponent(`${safeName}.zip`)}`,
    'Cache-Control': 'no-store'
  })
  return new Response(new Uint8Array(zip) as unknown as BodyInit)
})
