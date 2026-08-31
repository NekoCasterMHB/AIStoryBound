// server/api/world-gen/pull.post.ts
// 拉取共享缓存的世界:相同 txt 已由其他用户生成过时,扣记录消耗的一半直接入库为「已完成任务」。
// 与自建 key 无关(这是共享缓存服务费,不是 AI 调用),从平台余额原子扣费,余额不足 402;
// 缓存 downloads 计数 +1。拉取消耗记录在任务行 tokensUsed(不走 ai_usage,避免污染 AI 用量统计)。
import { and, eq, sql } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { user as usersTable, worldCache, worldGenTasks } from '../../db/schema'
import { uuid } from '../../../shared/novel'
import { cacheHalfCost } from '../../../shared/world-gen-task'
import { worldSourceKey } from '../../utils/world-gen-pipeline'
import { worldGenTaskToDTO } from '../../utils/world-gen-dto'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const body = await readBody<{ cacheId?: string }>(event).catch(() => ({}) as { cacheId?: string })
  const cacheId = String(body.cacheId ?? '')
  if (!cacheId) throw createError({ statusCode: 400, statusMessage: '缺少 cacheId' })

  const db = useD1(event)
  const cache = await db.select().from(worldCache).where(eq(worldCache.id, cacheId)).get()
  if (!cache) throw createError({ statusCode: 404, statusMessage: '缓存不存在或已被清理' })

  const cost = cacheHalfCost(cache.tokensUsed)
  if (cost > 0) {
    const claimed = await db.update(usersTable)
      .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${cost}` })
      .where(and(eq(usersTable.id, sessUser.id), sql`${usersTable.aiTokenBalance} >= ${cost}`))
      .run()
    if (claimed.meta.changes === 0) {
      throw createError({
        statusCode: 402,
        statusMessage: `token 余额不足(拉取需 ${cost}),请到个人中心购买加油包`
      })
    }
  }

  const taskId = uuid()
  const now = new Date()
  await db.insert(worldGenTasks).values({
    id: taskId,
    userId: sessUser.id,
    status: 'completed',
    stage: 'done',
    stageDetail: JSON.stringify({ doneUnits: 0, totalUnits: 0 }),
    sourceHash: cache.sourceHash,
    sourceKey: worldSourceKey(cache.sourceHash),
    fileSize: cache.fileSize,
    title: cache.title,
    author: cache.author,
    mode: cache.mode === 'eco' ? 'eco' : 'full',
    keySource: 'platform',
    estimatedTokens: 0,
    tokensUsed: cost,
    resultKey: cache.worldKey,
    warnings: '[]',
    createdAt: now,
    updatedAt: now
  }).run()

  await db.update(worldCache)
    .set({ downloads: sql`${worldCache.downloads} + 1`, updatedAt: now })
    .where(eq(worldCache.id, cacheId))
    .run()

  const row = await db.select().from(worldGenTasks).where(eq(worldGenTasks.id, taskId)).get()
  return { task: row ? worldGenTaskToDTO(row) : null }
})
