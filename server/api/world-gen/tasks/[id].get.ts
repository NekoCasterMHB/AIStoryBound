// server/api/world-gen/tasks/[id].get.ts
// 单个云端生成任务的进度/状态(生成页轮询)。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireUser } from '../../../utils/authz'
import { worldGenTasks } from '../../../db/schema'
import { ensureWorldGenTaskStarted } from '../../../utils/world-gen-start'
import { worldGenTaskToDTO } from '../../../utils/world-gen-dto'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少任务 id' })
  let row = await useD1(event).select()
    .from(worldGenTasks)
    .where(and(eq(worldGenTasks.id, id), eq(worldGenTasks.userId, sessUser.id)))
    .get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '任务不存在' })
  // 自愈与失败判定:仅 uploaded 任务可能被重启/判失败,此后才需要重读最新状态
  // (轮询热路径 running/completed 不做第二次查询)
  if (row.status === 'uploaded') {
    await ensureWorldGenTaskStarted(event, row, useD1(event))
    row = (await useD1(event).select()
      .from(worldGenTasks)
      .where(and(eq(worldGenTasks.id, id), eq(worldGenTasks.userId, sessUser.id)))
      .get()) ?? row
  }
  return { task: worldGenTaskToDTO(row) }
})
