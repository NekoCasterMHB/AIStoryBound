// app/utils/worldGenCloud.ts
// 云端世界生成任务的客户端编排:文件哈希 → 查重 → 上传建任务 → 轮询进度 → 下载 zip 自动安装。
// 服务端负责全部 AI 调用(Workflows),本模块只做传输、进度展示与结果安装;
// 自建 key 配置随上传表单上送云端加密暂存(任务结束即删),任务执行期间无需客户端在线。
import type { WorldCacheHit, WorldGenMode, WorldGenStepSwitches, WorldGenTaskDTO } from '#shared/world-gen-task'
import { postMergeRatio } from '#shared/world-gen-task'
import { saveWork, getWorkBySourceTask } from './worldGen'
import { loadBook2AsWork, saveBook2 } from './bookStoreV2'
import { bookZipToDoc } from '#shared/novel-v2'
import { importWorkFromBytes } from './shareZip'
import type { CharacterArc, LocalWork } from '#shared/novel'

export type { WorldCacheHit, WorldGenMode, WorldGenStepSwitches, WorldGenTaskDTO }

export const WORLD_GEN_TASKS_URL = '/api/world-gen/tasks'

/** 文本内容 sha-256(hex;查重与共享缓存键,基于转换后的 UTF-8 文本而非原始文件字节) */
export async function hashText(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

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
  /** 自定义模式的步骤开关(仅 mode=custom 使用;随任务上送,服务端持久化到任务行 payload) */
  steps?: WorldGenStepSwitches | null
  /** 客户端解析出的正文字数(服务端预授权估算用) */
  charCount: number
  /** 自建 key 配置(浏览器本地已验证的激活配置;上送云端加密暂存,任务结束即删) */
  config?: { format: string, baseUrl: string, apiKey: string, model: string } | null
  /** 命中共享缓存时强制重新生成(重新上传第二次时携带);缺省由服务端返回 cacheHit 供客户端选择 */
  forceRegenerate?: boolean
  onUploadProgress?: (loaded: number, total: number) => void
}

export interface UploadWorldGenResult {
  task: WorldGenTaskDTO | null
  cacheHit: WorldCacheHit | null
}

/** 上传原文并创建云端任务(XHR 以拿到上传进度;服务端重算 hash 校验)。
 *  命中共享缓存且未带 forceRegenerate 时返回 { task: null, cacheHit },由调用方选择拉取/重新生成。 */
export function uploadWorldGenTask(opts: UploadOptions): Promise<UploadWorldGenResult> {
  const form = new FormData()
  form.append('file', opts.file, opts.file.name)
  form.append('mode', opts.mode)
  form.append('charCount', String(Math.max(0, Math.round(opts.charCount))))
  if (opts.mode === 'custom' && opts.steps) form.append('steps', JSON.stringify(opts.steps))
  if (opts.config) form.append('config', JSON.stringify(opts.config))
  if (opts.forceRegenerate) form.append('forceRegenerate', '1')

  return new Promise<UploadWorldGenResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/world-gen/upload')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onUploadProgress?.(e.loaded, e.total)
    }
    xhr.onload = () => {
      const res = xhr.response as { task?: WorldGenTaskDTO | null, cacheHit?: WorldCacheHit | null, statusMessage?: string, message?: string } | null
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ task: res?.task ?? null, cacheHit: res?.cacheHit ?? null })
      } else {
        const msg = res?.statusMessage ?? res?.message ?? `上传失败(HTTP ${xhr.status})`
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

export interface SupplementArcsArgs {
  workId: string
  title: string
  entities: LocalWork['entities']
  storyline: LocalWork['storyline']
  /** 全书正文(chapters.join('\n');服务端用于登场段原文窗口注入) */
  text?: string
  /** 逐段事实底稿(段角色文件的 剧情/状态;arcs 精写的事实依据,见 format-v2 §6.1) */
  plots?: { name: string, beatIndex: number, plot?: string | null, status?: string | null }[]
  /** 自建 key 配置(浏览器本地已验证的激活配置;上送云端加密暂存,任务结束即删) */
  config?: { format: string, baseUrl: string, apiKey: string, model: string } | null
}

/** 创建「补充生成配角故事线」云端任务(服务端逐单元生成,运行中只记账、完成时一次性结算) */
export async function startSupplementArcsTask(args: SupplementArcsArgs): Promise<WorldGenTaskDTO> {
  const res = await $fetch<{ task: WorldGenTaskDTO | null }>('/api/world-gen/arcs', {
    method: 'POST',
    body: args
  })
  if (!res.task) throw new Error('创建任务失败:服务端未返回任务')
  return res.task
}

/** 读取已完成 arcs 任务的弧线结果(客户端据此写入本地作品 characterArcs) */
export async function fetchArcsResult(id: string): Promise<CharacterArc[]> {
  const res = await $fetch<{ arcs: CharacterArc[] }>(`${WORLD_GEN_TASKS_URL}/${id}/arcs`)
  return res.arcs ?? []
}

/** 恢复暂停中的任务(充值后继续;已完成单元自动复用,成功完成后一次性结算) */
export async function resumeWorldGenTask(id: string): Promise<WorldGenTaskDTO> {
  const res = await $fetch<{ task: WorldGenTaskDTO | null }>(`${WORLD_GEN_TASKS_URL}/${id}/resume`, { method: 'POST' })
  if (!res.task) throw new Error('继续失败:服务端未返回任务')
  return res.task
}

/** 轮询任务直至终态(completed/failed/cancelled/paused);onUpdate 每次快照回调,signal 可中断。
 *  区间退避:首分钟 3s,之后 6s,10 分钟后 12s 封顶(长任务不刷接口;状态变更感知延迟对 UX 无感)。 */
export async function pollWorldGenTask(
  id: string,
  onUpdate: (task: WorldGenTaskDTO) => void,
  signal?: AbortSignal,
  intervalMs = 3000
): Promise<WorldGenTaskDTO> {
  const startedAt = Date.now()
  const currentInterval = () => {
    const elapsed = Date.now() - startedAt
    if (elapsed > 10 * 60_000) return intervalMs * 4
    if (elapsed > 60_000) return intervalMs * 2
    return intervalMs
  }
  for (;;) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const task = await fetchWorldGenTask(id)
    onUpdate(task)
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'paused') {
      return task
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, currentInterval())
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('已取消', 'AbortError'))
      }, { once: true })
    })
  }
}

export interface InstallOptions {
  /** 本地已有同一任务的作品时由调用方弹确认框决定是否覆盖;未传则静默返回已存在作品(不重复落库) */
  onDuplicate?: (existing: LocalWork) => Promise<boolean>
}

/**
 * 下载成书并安装进本地书架,返回新作品。
 * 新生成任务(v2):优先下载 aisb-book zip → book2 真源落库(IndexedDB book2 表);旧任务无 v2 产物自动回退 v1。
 * 同一任务只允许落一本:先按 sourceTaskId(v1)或 book2 行 id(v2)查已安装作品,已存在则按调用方意愿覆盖或跳过,
 * 防止生成页/书架页/多标签页对同一任务重复安装出多本一样的书。
 */
export async function downloadAndInstallWorldTask(task: WorldGenTaskDTO, opts?: InstallOptions): Promise<LocalWork> {
  // v2 产物存在时优先走 v2(book2 真源,id = 任务 id,重复安装幂等覆盖)
  try {
    const buf = await $fetch<ArrayBuffer>(`${WORLD_GEN_TASKS_URL}/${task.id}/download-v2`, { responseType: 'arrayBuffer' })
    const doc = bookZipToDoc(new Uint8Array(buf))
    const existingV2 = await loadBook2AsWork(task.id)
    if (existingV2) {
      if (!opts?.onDuplicate) return existingV2
      const overwrite = await opts.onDuplicate(existingV2)
      if (!overwrite) return existingV2
    } else {
      // v1 已装过同一任务的旧安装:视作重复(调用方决定覆盖/跳过)
      const existingV1 = await getWorkBySourceTask(task.id)
      if (existingV1 && !opts?.onDuplicate) return existingV1
    }
    await saveBook2(doc, task.id)
    const work = await loadBook2AsWork(task.id)
    if (work) return work
  } catch (e) {
    // 404/410 = 无 v2 产物(旧任务),走 v1;其余错误也回退 v1(成书不可因 v2 链路失败而不可用)
    console.warn('[world-gen] v2 下载/安装失败,回退 v1', task.id, e)
  }
  const existing = await getWorkBySourceTask(task.id)
  if (existing) {
    if (!opts?.onDuplicate) return existing
    const overwrite = await opts.onDuplicate(existing)
    if (!overwrite) return existing
  }
  const url = task.downloadUrl ?? `${WORLD_GEN_TASKS_URL}/${task.id}/download`
  const buf = await $fetch<ArrayBuffer>(url, { responseType: 'arrayBuffer' })
  const work = await importWorkFromBytes(new Uint8Array(buf))
  if (existing) work.id = existing.id // 覆盖:保留原记录 id,用新内容替换,书架不新增一条
  work.sourceTaskId = task.id
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
    case 'paused': // 暂停:按当前阶段显示已推进到的位置
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
    case 'arcs': {
      // 按故事线条数推进:10%(第 0 条)→ 90%(最后一条)
      return Math.round(10 + unitRatio * 80)
    }
    case 'annotate': // 标剧情转折:粗段合并为剧情段并生成节点[](v2 正典)
      return 96
    case 'synthesize': {
      // merge 后三分支(成书/弧线/标转折)并行:按整体完成度推进 86→97;
      // 旧任务/独立 arcs 任务无分支子字段(postMergeRatio=null),维持原 95
      const r = postMergeRatio(task.stageDetail)
      return r === null ? 95 : Math.round(86 + r * 11)
    }
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
  if (task.status === 'paused') return task.stage === 'done' ? '待结算(余额不足)' : '已暂停'
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
    case 'arcs': {
      const { doneUnits, totalUnits } = task.stageDetail
      return totalUnits > 0 ? `补充故事线 ${doneUnits}/${totalUnits}` : '补充故事线'
    }
    case 'synthesize': {
      // 并行收尾阶段:展示最落后分支的具体进度;全部完成后进入整理产物
      const d = task.stageDetail
      if (d.annotate && d.annotate.totalUnits > 0 && d.annotate.doneUnits < d.annotate.totalUnits) {
        return `标注剧情转折 ${d.annotate.doneUnits}/${d.annotate.totalUnits}`
      }
      if (d.arcs && d.arcs.totalUnits > 0 && d.arcs.doneUnits < d.arcs.totalUnits) {
        return `补充故事线 ${d.arcs.doneUnits}/${d.arcs.totalUnits}`
      }
      return d.synthDone ? '整理产物' : '成书中'
    }
    case 'annotate': return '标注剧情转折'
    case 'done': return '完成'
    default: return '处理中'
  }
}
