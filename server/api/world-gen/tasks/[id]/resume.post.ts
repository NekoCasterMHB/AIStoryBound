// server/api/world-gen/tasks/[id]/resume.post.ts
// 继续暂停中的云端任务(充值后由用户手动继续),两类 paused:
//  - 已完成待结算(stage='done',完成时一次性结算余额不足):任务结果已生成,只差补扣,需余额 >= 实际消耗 tokensUsed;
//  - 历史断点暂停(旧逐笔扣费模型):需余额 >= 剩余预估(估算 - 已消耗)。
//  - 任务转 running,另起一个新 Workflow 实例(实例 id 带 -r<时间戳> 后缀;原实例已正常结束不可复用);
//  - 管线步骤全部幂等(提取单元 world_gen_units / 检查点 scratch 复用),重跑直达结算/落盘。
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

  // 余额充足性:已完成待结算需补扣实际消耗;断点暂停需覆盖剩余预估。不足提示需充值金额
  const remaining = row.stage === 'done'
    ? Math.max(1, row.tokensUsed)
    : Math.max(1, Math.max(0, row.estimatedTokens - row.tokensUsed))
  const me = await db.select({ aiTokenBalance: usersTable.aiTokenBalance })
    .from(usersTable)
    .where(eq(usersTable.id, sessUser.id))
    .get()
  if (!me || (me.aiTokenBalance ?? 0) < remaining) {
    throw createError({
      statusCode: 402,
      statusMessage: `token 余额不足,本次续跑/结算需约 ${remaining.toLocaleString()} tokens,请先充值`
    })
  }

  await markTask({ db, taskId: id }, { status: 'running', error: null })
  await startWorldGenTask(event, id, `${id}-r${Date.now()}`)

  const fresh = await db.select().from(worldGenTasks).where(eq(worldGenTasks.id, id)).get()
  return { task: fresh ? worldGenTaskToDTO(fresh) : null }
})
