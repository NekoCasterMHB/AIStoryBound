// server/utils/world-gen-start.ts
// 云端任务的启动、自愈与异常检测:
//  - 优先 Workflow binding(env.WORLD_GEN.create,实例 id = 任务 id,重复 create 报 exist 视为已在跑);
//  - 无 binding(本地 dev 的 getPlatformProxy 不一定模拟 workflows / 生产 binding 缺失)时回退内联执行:
//    dev 的 Node 进程常驻,promise 直接后台跑;生产用 event.waitUntil 挂载——但 waitUntil 不保证存在
//    (nitro 自身也用 if (event?.waitUntil) 防御),必须容错,否则任务行建出来却永远停在 uploaded。
//  - 异常检测(把「工作流没跑起来/悄悄死掉」转成任务行上的可见失败):
//    ① uploaded 停留超过 STALE_UPLOADED_MS → 视为启动丢失,重新触发启动(自愈);
//    ② uploaded 停留超过 START_FAIL_TIMEOUT_MS(如部署被回滚、Workflow 类缺失导致 run 分发失败,
//       create 报 already-exists 无法恢复)→ 判失败并退款,不再无限重试;
//    ③ running 静默超过 STALE_RUNNING_MS(见 world-gen-pipeline 的孤儿清扫)→ 判失败并退款。
import type { H3Event } from 'h3'
import { createWorldGenCtx, markTaskFailed, runWorldGenPipelineInline } from './world-gen-pipeline'
import type { WorldGenTaskRow } from './world-gen-pipeline'

/** uploaded 停留超过该时长仍未进入 running:视为启动丢失,重新触发启动(自愈) */
const STALE_UPLOADED_MS = 15_000
/** uploaded 停留超过该时长:执行环境异常(分发失败/实例已 errored 无法复用),判失败 */
const START_FAIL_TIMEOUT_MS = 3 * 60_000

interface StartEnv {
  DB: D1Database
  SKILL_FILES: R2Bucket
  BETTER_AUTH_SECRET?: string
  AI_BASE_URL?: string
  AI_API_KEY?: string
  AI_MODEL?: string
  WORLD_GEN?: { create: (opts: { id: string, params: { taskId: string } }) => Promise<unknown> }
}

function getEnv(event: H3Event): StartEnv | undefined {
  return (event.context as unknown as { cloudflare?: { env?: StartEnv } }).cloudflare?.env
}

/**
 * 启动(或重启)一次任务执行。幂等:实例 id 默认 = 任务 id,重复 create 报 exist 视为已在跑;
 * 续跑(pause→resume)传新 instanceId(如 `${taskId}-r<时间戳>`)另起实例,单元明细按 taskId 复用断点。
 */
export async function startWorldGenTask(event: H3Event, taskId: string, instanceId = taskId): Promise<'workflow' | 'inline'> {
  const env = getEnv(event)
  if (env?.WORLD_GEN) {
    try {
      await env.WORLD_GEN.create({ id: instanceId, params: { taskId } })
      return 'workflow'
    } catch (e) {
      const msg = (e as Error)?.message ?? ''
      if (/exist|duplicate/i.test(msg)) {
        return 'workflow' // 实例已存在 = 已在执行(或已执行过),幂等
      }
      console.error('[world-gen] Workflow 启动失败,回退内联执行', { taskId }, e)
    }
  } else {
    console.warn('[world-gen] 无 WORLD_GEN binding,内联执行兜底', { taskId })
  }

  // 内联兜底:先启动 promise(Node dev 进程常驻,任务可持续跑),
  // 再尽力挂 waitUntil(生产缺 binding 时尽量延续执行;dev 无 waitUntil 也不影响)
  const pipeline = runWorldGenPipelineInline(createWorldGenCtx(env!, taskId))
  try {
    event.waitUntil?.(pipeline)
  } catch {
    // waitUntil 不可用:dev 常驻进程下 promise 照常执行
  }
  return 'inline'
}

/**
 * 自愈与失败判定(任务列表/详情轮询接口对每个 uploaded 任务调用):
 *  - 停留 < STALE_UPLOADED_MS:刚创建,不动;
 *  - 停留 < START_FAIL_TIMEOUT_MS:重新触发启动(自愈;实例已存在时 create 幂等无副作用);
 *  - 停留 ≥ START_FAIL_TIMEOUT_MS:执行环境异常(重启也救不回,如实例已 errored),判失败并退款,
 *    错误信息写回任务行,用户在书架/生成页可见。
 */
export async function ensureWorldGenTaskStarted(
  event: H3Event,
  task: WorldGenTaskRow,
  db: Parameters<typeof markTaskFailed>[0]['db']
): Promise<void> {
  if (task.status !== 'uploaded') return
  const staleFor = Date.now() - task.updatedAt.getTime()
  if (staleFor < STALE_UPLOADED_MS) return

  if (staleFor >= START_FAIL_TIMEOUT_MS) {
    console.error('[world-gen] 任务长时间未启动,判定执行环境异常', { taskId: task.id, staleFor })
    await markTaskFailed(
      { db, taskId: task.id },
      '任务长时间未能启动(执行环境异常,可能为部署回滚或工作流不可用),未产生扣费;请稍后重新上传重试'
    )
    return
  }

  console.warn('[world-gen] 任务停在 uploaded,自愈重启', { taskId: task.id, staleFor })
  await startWorldGenTask(event, task.id)
}
