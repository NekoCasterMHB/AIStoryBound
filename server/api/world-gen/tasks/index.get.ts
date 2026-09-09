// server/api/world-gen/tasks/index.get.ts
// 当前用户的云端生成任务列表(书架「云端任务」区块;前端存在活动任务时轮询,区间退避)。
// 顺带做孤儿任务兜底清扫(running 超时判失败 / 终态残留 key 清空 / 失败任务过期 scratch 回收),
// 见 sweepStaleWorldGenTasks。
import { desc, eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireUser } from '../../../utils/authz'
import { worldGenTasks } from '../../../db/schema'
import { sweepStaleWorldGenTasks } from '../../../utils/world-gen-pipeline'
import { ensureWorldGenTaskStarted } from '../../../utils/world-gen-start'
import { worldGenTaskToDTO } from '../../../utils/world-gen-dto'

/** 孤儿清扫节流:前端轮询 3-12s 一次,清扫(全量扫描 + 可能的 R2 list/delete)至多 60s 跑一次。
 *  节流标记在同一 isolate 内共享;跨 isolate 至多各跑一次,无正确性影响 */
let lastSweepAt = 0
const SWEEP_INTERVAL_MS = 60_000

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  const env = (event.context as unknown as { cloudflare?: { env?: { SKILL_FILES?: R2Bucket } } }).cloudflare?.env
  const now = Date.now()
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lastSweepAt = now
    await sweepStaleWorldGenTasks(db, env?.SKILL_FILES)
  }
  const rows = await db.select()
    .from(worldGenTasks)
    .where(eq(worldGenTasks.userId, sessUser.id))
    .orderBy(desc(worldGenTasks.createdAt))
    .limit(50)
    .all()
  // 自愈与失败判定:停在 uploaded 的任务按停留时长重启或判失败(分发异常/实例 errored 时转成可见错误)
  for (const row of rows) {
    await ensureWorldGenTaskStarted(event, row, db)
  }
  return { tasks: rows.map(worldGenTaskToDTO) }
})
