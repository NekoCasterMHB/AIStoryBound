// server/api/world-gen/tasks/[id]/arcs.get.ts
// 读取 arcs(补充配角故事线)任务结果:校验归属且任务已完成后,返回管线写入 R2 scratch 的弧线数组,
// 客户端据此写入本地作品的 characterArcs。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { worldGenTasks } from '../../../../db/schema'
import { createWorldGenCtx, getScratch } from '../../../../utils/world-gen-pipeline'
import type { WorldGenEnv } from '../../../../utils/world-gen-pipeline'
import type { CharacterArc } from '../../../../../shared/novel'

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
  if (row.kind !== 'arcs') throw createError({ statusCode: 400, statusMessage: '该任务不是配角故事线任务' })
  if (row.status !== 'completed') throw createError({ statusCode: 409, statusMessage: '任务尚未完成' })

  const env = (event.context as unknown as { cloudflare?: { env?: Env } }).cloudflare?.env as WorldGenEnv | undefined
  if (!env?.DB || !env.SKILL_FILES) throw createError({ statusCode: 500, statusMessage: '存储未就绪' })
  const ctx = createWorldGenCtx(env, id)
  const arcs = await getScratch<CharacterArc[]>(ctx, 'arcs')
  return { arcs: arcs ?? [] }
})
