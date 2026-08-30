// server/api/world-gen/tasks/index.get.ts
// 当前用户的云端生成任务列表(书架「云端任务」区块;前端存在活动任务时每 3s 轮询)。
// 顺带做孤儿任务兜底清扫(running 超时判失败退款 / 终态残留 key 清空),见 sweepStaleWorldGenTasks。
import { desc, eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireUser } from '../../../utils/authz'
import { worldGenTasks } from '../../../db/schema'
import { sweepStaleWorldGenTasks } from '../../../utils/world-gen-pipeline'
import { ensureWorldGenTaskStarted } from '../../../utils/world-gen-start'
import { worldGenTaskToDTO } from '../../../utils/world-gen-dto'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  await sweepStaleWorldGenTasks(db)
  const rows = await db.select()
    .from(worldGenTasks)
    .where(eq(worldGenTasks.userId, sessUser.id))
    .orderBy(desc(worldGenTasks.createdAt))
    .limit(50)
    .all()
  // 自愈:停在 uploaded 超时的任务重新触发启动(启动丢失/Workflow binding 曾缺失等场景)
  for (const row of rows) {
    await ensureWorldGenTaskStarted(event, row)
  }
  return { tasks: rows.map(worldGenTaskToDTO) }
})
