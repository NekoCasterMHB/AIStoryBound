// server/api/world-gen/tasks/[id].delete.ts
// 取消或删除云端生成任务:
//  - uploaded/running/paused:置 cancelled + 结算(旧预扣任务退差额)+ 清 key 暂存 + terminate Workflow 实例;
//  - completed/failed/cancelled:删除任务行(提取单元明细级联删除;R2 缓存为共享资源不删)。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireUser } from '../../../utils/authz'
import { worldGenTasks } from '../../../db/schema'
import { clearTaskKey, settleTaskBilling } from '../../../utils/world-gen-pipeline'

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

  if (row.status === 'uploaded' || row.status === 'running' || row.status === 'paused') {
    await db.update(worldGenTasks)
      .set({ status: 'cancelled', error: null, updatedAt: new Date() })
      .where(eq(worldGenTasks.id, id))
      .run()
    await settleTaskBilling({ db, taskId: id })
    await clearTaskKey({ db, taskId: id })
    // 终止执行中的 Workflow 实例(本地 dev 内联执行靠 assertNotCancelled 自行退出)
    const env = (event.context as unknown as { cloudflare?: { env?: Env } }).cloudflare?.env
    if (env?.WORLD_GEN) {
      try {
        const instance = await env.WORLD_GEN.get(id)
        await instance.terminate()
      } catch {
        // 实例不存在/已结束:忽略
      }
    }
    return { cancelled: true }
  }

  await db.delete(worldGenTasks).where(eq(worldGenTasks.id, id)).run()
  return { cancelled: false, deleted: true }
})
