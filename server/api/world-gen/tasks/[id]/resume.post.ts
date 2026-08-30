// server/api/world-gen/tasks/[id]/resume.post.ts
// 续跑暂停中的云端任务(余额不足时自动暂停;充值后由用户手动继续):
//  - 校验归属与状态(paused 才能续跑)+ 余额充足性(按 剩余预估 = estimated - used 判定);
//  - 任务转 running,另起一个新 Workflow 实例(实例 id 带 -r<时间戳> 后缀;原实例已正常结束不可复用);
//  - 已完成的提取单元从 world_gen_units 复用(断点续跑),只补缺失单元的调用与扣费。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { worldGenTasks, user as usersTable } from '../../../../db/schema'
import { markTask } from '../../../../utils/world-gen-pipeline'
import { startWorldGenTask } from '../../../../utils/world-gen-start'
import { worldGenTaskToDTO } from '../../../../utils/world-gen-dto'

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
  if (row.status !== 'paused') {
    throw createError({ statusCode: 409, statusMessage: '任务不在暂停状态,无法继续' })
  }

  // 余额充足性:剩余预估(估算 - 已消耗)至少要能覆盖;不足提示需充值金额
  const remaining = Math.max(1, Math.max(0, row.estimatedTokens - row.tokensUsed))
  const me = await db.select({ aiTokenBalance: usersTable.aiTokenBalance })
    .from(usersTable)
    .where(eq(usersTable.id, sessUser.id))
    .get()
  if (!me || (me.aiTokenBalance ?? 0) < remaining) {
    throw createError({
      statusCode: 402,
      statusMessage: `token 余额不足以继续本任务(预计还需约 ${remaining.toLocaleString()}),请先充值`
    })
  }

  await markTask({ db, taskId: id }, { status: 'running', error: null })
  await startWorldGenTask(event, id, `${id}-r${Date.now()}`)

  const fresh = await db.select().from(worldGenTasks).where(eq(worldGenTasks.id, id)).get()
  return { task: fresh ? worldGenTaskToDTO(fresh) : null }
})
