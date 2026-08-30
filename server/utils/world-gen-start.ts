// server/utils/world-gen-start.ts
// 云端任务的启动与自愈:
//  - 优先 Workflow binding(env.WORLD_GEN.create,实例 id = 任务 id,重复 create 报 exist 视为已在跑);
//  - 无 binding(本地 dev 的 getPlatformProxy 不一定模拟 workflows / 生产 binding 缺失)时回退内联执行:
//    dev 的 Node 进程常驻,promise 直接后台跑;生产用 event.waitUntil 挂载——但 waitUntil 不保证存在
//    (nitro 自身也用 if (event?.waitUntil) 防御),必须容错,否则任务行建出来却永远停在 uploaded。
//  - 轮询接口对「uploaded 超过 STALE_UPLOADED_MS 仍没启动」的任务重新触发启动(自愈)。
import type { H3Event } from 'h3'
import { createWorldGenCtx, runWorldGenPipelineInline } from './world-gen-pipeline'
import type { WorldGenTaskRow } from './world-gen-pipeline'

/** uploaded 状态超过该时长仍未进入 running,视为启动失败,由轮询接口自愈重启 */
const STALE_UPLOADED_MS = 15_000

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
 * 启动(或重启)一次任务执行。幂等:Workflow 实例 id = 任务 id,重复 create 无副作用。
 * 返回实际启动方式,便于日志与接口回显。
 */
export async function startWorldGenTask(event: H3Event, taskId: string): Promise<'workflow' | 'inline'> {
  const env = getEnv(event)
  if (env?.WORLD_GEN) {
    try {
      await env.WORLD_GEN.create({ id: taskId, params: { taskId } })
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
 * 自愈:任务停在 uploaded 超过阈值(启动丢失/未触发)时重新启动。
 * 供任务列表/详情轮询接口调用;运行中/终态任务不做任何事。
 */
export async function ensureWorldGenTaskStarted(event: H3Event, task: WorldGenTaskRow): Promise<void> {
  if (task.status !== 'uploaded') return
  const staleFor = Date.now() - task.updatedAt.getTime()
  if (staleFor < STALE_UPLOADED_MS) return
  console.warn('[world-gen] 任务停在 uploaded 超时,自愈重启', { taskId: task.id, staleFor })
  await startWorldGenTask(event, task.id)
}
