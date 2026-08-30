// app/utils/worldGenCloud.ts
// 云端世界生成任务的客户端编排:文件哈希 → 查重 → 上传建任务 → 轮询进度 → 下载 zip 自动安装。
// 服务端负责全部 AI 调用(Workflows),本模块只做传输、进度展示与结果安装;
// 自建 key 配置随上传表单上送云端加密暂存(任务结束即删),任务执行期间无需客户端在线。
import type { WorldCacheHit, WorldGenMode, WorldGenTaskDTO } from '#shared/world-gen-task'
import { saveWork } from './worldGen'
import { importWorkFromBytes } from './shareZip'
import type { LocalWork } from '#shared/novel'

export type { WorldCacheHit, WorldGenMode, WorldGenTaskDTO }

export const WORLD_GEN_TASKS_URL = '/api/world-gen/tasks'

/** 文件内容 sha-256(十六进制;查重与共享缓存键,不含文件名) */
export async function hashFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 查重:相同 hash + 模式是否已有共享成书 */
export async function checkWorldDuplicate(hash: string, mode: WorldGenMode): Promise<WorldCacheHit | null> {
  const res = await $fetch<{ hit: WorldCacheHit | null }>('/api/world-gen/check', {
    method: 'POST',
    body: { hash, mode }
  })
  return res.hit
}

export interface UploadOptions {
  file: File
  mode: WorldGenMode
  /** 客户端解析出的正文字数(服务端预授权估算用) */
  charCount: number
  /** 自建 key 配置(浏览器本地已验证的激活配置;上送云端加密暂存,任务结束即删) */
  config?: { format: string, baseUrl: string, apiKey: string, model: string } | null
  onUploadProgress?: (loaded: number, total: number) => void
}

/** 上传原文并创建云端任务(XHR 以拿到上传进度;服务端重算 hash 校验) */
export function uploadWorldGenTask(opts: UploadOptions): Promise<WorldGenTaskDTO> {
  const form = new FormData()
  form.append('file', opts.file, opts.file.name)
  form.append('mode', opts.mode)
  form.append('charCount', String(Math.max(0, Math.round(opts.charCount))))
  if (opts.config) form.append('config', JSON.stringify(opts.config))

  return new Promise<WorldGenTaskDTO>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/world-gen/upload')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onUploadProgress?.(e.loaded, e.total)
    }
    xhr.onload = () => {
      const res = xhr.response as { task?: WorldGenTaskDTO | null } | null
      if (xhr.status >= 200 && xhr.status < 300 && res?.task) {
        resolve(res.task)
      } else {
        const msg = (res as { statusMessage?: string } | null)?.statusMessage
          ?? (xhr.response as { message?: string } | null)?.message
          ?? `上传失败(HTTP ${xhr.status})`
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误,上传失败'))
    xhr.onabort = () => reject(new Error('上传已取消'))
    xhr.send(form)
  })
}

/** 拉取共享缓存(扣记录消耗的一半,直接得到已完成任务) */
export async function pullCachedWorld(cacheId: string): Promise<WorldGenTaskDTO> {
  const res = await $fetch<{ task: WorldGenTaskDTO | null }>('/api/world-gen/pull', {
    method: 'POST',
    body: { cacheId }
  })
  if (!res.task) throw new Error('拉取失败:服务端未返回任务')
  return res.task
}

/** 单个任务进度 */
export async function fetchWorldGenTask(id: string): Promise<WorldGenTaskDTO> {
  const res = await $fetch<{ task: WorldGenTaskDTO }>(`${WORLD_GEN_TASKS_URL}/${id}`)
  return res.task
}

/** 用户任务列表(书架) */
export async function fetchWorldGenTasks(): Promise<WorldGenTaskDTO[]> {
  const res = await $fetch<{ tasks: WorldGenTaskDTO[] }>(WORLD_GEN_TASKS_URL)
  return res.tasks
}

/** 取消进行中的任务 / 删除历史任务 */
export async function cancelWorldGenTask(id: string): Promise<void> {
  await $fetch(`${WORLD_GEN_TASKS_URL}/${id}`, { method: 'DELETE' })
}

/** 轮询任务直至终态(completed/failed/cancelled);onUpdate 每次快照回调,signal 可中断 */
export async function pollWorldGenTask(
  id: string,
  onUpdate: (task: WorldGenTaskDTO) => void,
  signal?: AbortSignal,
  intervalMs = 3000
): Promise<WorldGenTaskDTO> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const task = await fetchWorldGenTask(id)
    onUpdate(task)
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return task
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('已取消', 'AbortError'))
      }, { once: true })
    })
  }
}

/** 下载成书 zip 并安装进本地书架(IndexedDB works);返回新作品 */
export async function downloadAndInstallWorldTask(task: WorldGenTaskDTO): Promise<LocalWork> {
  const url = task.downloadUrl ?? `${WORLD_GEN_TASKS_URL}/${task.id}/download`
  const buf = await $fetch<ArrayBuffer>(url, { responseType: 'arrayBuffer' })
  const work = await importWorkFromBytes(new Uint8Array(buf))
  await saveWork(work)
  return work
}

/** 各阶段占总进度的区间(extract 段按单元线性推进) */
export function worldGenTaskPercent(task: WorldGenTaskDTO): number {
  switch (task.status) {
    case 'completed':
      return 100
    case 'failed':
    case 'cancelled':
      return 100
    case 'uploaded':
      return 2
    case 'running':
      break
  }
  const { doneUnits, totalUnits } = task.stageDetail
  const unitRatio = totalUnits > 0 ? Math.min(1, doneUnits / totalUnits) : 0
  switch (task.stage) {
    case 'parse':
      return 6
    case 'author':
      return 10
    case 'extract':
      return Math.round(15 + unitRatio * 65)
    case 'merge':
      return 85
    case 'check':
      return 90
    case 'synthesize':
      return 95
    case 'done':
      return 100
    default:
      return 5
  }
}

/** 阶段中文标签 */
export function worldGenStageLabel(task: WorldGenTaskDTO): string {
  if (task.status === 'uploaded') return '排队中'
  if (task.status === 'failed') return '失败'
  if (task.status === 'cancelled') return '已取消'
  if (task.status === 'completed') return '已完成'
  switch (task.stage) {
    case 'parse': return '解析原文'
    case 'author': return '识别作者'
    case 'extract': {
      const { doneUnits, totalUnits } = task.stageDetail
      return totalUnits > 0 ? `提取设定 ${doneUnits}/${totalUnits}` : '提取设定'
    }
    case 'merge': return '合并实体'
    case 'check': return '一致性检查'
    case 'synthesize': return '成书中'
    case 'done': return '完成'
    default: return '处理中'
  }
}
