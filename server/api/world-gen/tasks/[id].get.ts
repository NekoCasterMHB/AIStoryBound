// server/api/world-gen/tasks/[id].get.ts
// 单个云端生成任务的进度/状态(生成页轮询)。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireUser } from '../../../utils/authz'
import { worldGenTasks } from '../../../db/schema'
import { worldGenTaskToDTO } from '../../../utils/world-gen-dto'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少任务 id' })
  const row = await useD1(event).select()
    .from(worldGenTasks)
    .where(and(eq(worldGenTasks.id, id), eq(worldGenTasks.userId, sessUser.id)))
    .get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '任务不存在' })
  return { task: worldGenTaskToDTO(row) }
})
