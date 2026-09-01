// app/utils/aiRelay.ts
// AI 中继浏览器客户端:统一封装 POST /api/ai/chat(SSE 流式)。
// - aiChat: 流式(回合叙事等),onDelta 逐片回调,返回总 usage
// - aiChatJson: 请求 json:true,累积所有 delta 后抽取 JSON(生成管线/选项结构化用)
import { extractJson } from '#shared/json'
import {
  estimateMessagesTokens,
  estimateTextTokens,
  finalizeStreamUsage,
  mergeTokenUsage,
  normalizeTokenUsage
} from '#shared/token-estimate'
import { getActiveRelayConfig } from './aiConfigStore'

export interface RelayedUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/** 实时估算信息(字符 → token,含速度;用于生成/回合期间实时消耗展示) */
export interface LiveTokenInfo {
  /** 当前这轮流式调用的估算 token 数 = 本次调用的 prompt 输入 + 已流出的输出(不含已入账的真实用量) */
  tokens: number
  /** tokens/秒(当前流,含输入基数) */
  speed: number
  elapsedMs: number
}

/** 调用被 AbortSignal 取消时抛出(生成取消/页面卸载等),调用方可据此区分"取消"与"失败" */
export class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

export interface AiChatOptions {
  json?: boolean
  maxTokens?: number
  temperature?: number
  /** 单次中继调用超时(毫秒);缺省用平台默认 600s */
  timeoutMs?: number
  /** 思考开关:已废弃,请求体固定 thinking:false 强制关闭(服务端 chat 格式显式发送 thinking:{type:'disabled'}) */
  thinking?: boolean
  /** 用途路由(仅平台模式生效):'worldGen'=生成世界流水线,'chat'=对话类(缺省)。
   *  服务端按管理员配置的用途路由选择对应配置行;自建 key 模式忽略此字段 */
  purpose?: 'worldGen' | 'chat'
}

/** 解析上游 SSE 的 data: 行(可能跨块,按行缓冲);onData 拿到原始 JSON,由调用方决定取哪些字段 */
function makeDataLineParser(onData: (json: string) => void) {
  let buf = ''
  return (text: string) => {
    buf += text
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const json = line.slice(5).trim()
      if (!json || json === '[DONE]') continue
      onData(json)
    }
  }
}

/**
 * 解析单条上游 SSE JSON,提取正文增量。
 * DeepSeek 推理模型把思考过程放在 reasoning_content,正文在 content;
 * 有的模型只给 reasoning_content 而 content 为空(输出 0 字符的根因),
 * 这里把 content 与 reasoning_content 合并为正文增量,保证结构化调用能拿到文本。
 */
interface UpstreamDelta {
  content?: string
  reasoning_content?: string
}

function parseUpstreamChunk(json: string): { delta?: UpstreamDelta, usage?: RelayedUsage } | null {
  try {
    const d = JSON.parse(json) as {
      choices?: { delta?: UpstreamDelta }[]
      usage?: Record<string, unknown>
    }
    return { delta: d.choices?.[0]?.delta, usage: d.usage ? normalizeTokenUsage(d.usage) : undefined }
  } catch {
    return null
  }
}

/**
 * 调用 AI 中继。返回 { usage } 与 { ok:false, message } 失败信息(402/502 等);
 * 网络层异常抛 Error;signal 触发取消时抛 CancelledError。
 */
export async function aiChat(
  messages: { role: 'system' | 'user' | 'assistant', content: string }[],
  opts: AiChatOptions,
  handlers: {
    onDelta?: (delta: string) => void
    onUsage?: (usage: RelayedUsage) => void
  } = {},
  signal?: AbortSignal
): Promise<{ usage?: RelayedUsage, ok: true } | { ok: false, status: number, message: string }> {
  // 总超时兜底(默认与服务端 RELAY_TIMEOUT_DEFAULT_MS 一致):timeoutMs 既随请求体交服务端,
  // 也在此生成浏览器侧 AbortSignal。服务端超时只覆盖"拿到响应头"阶段(AbortSignal.timeout
  // 在 fetch resolve 后失效),若上游在流中途挂起,服务端 relaySse 会一直读不到数据,
  // 前端必须自行限时,否则调用永不返回(生成进度卡死的根因)。
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 600_000
  const ctrl = new AbortController()
  const onOuterAbort = () => ctrl.abort()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  signal?.addEventListener('abort', onOuterAbort)
  const timeoutError = () => new Error(`AI 调用超时(超过 ${Math.round(timeoutMs / 1000)}s),请重试`)
  let res: Response
  try {
    try {
      res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        // 浏览器本地自建配置随请求临时携带(不落库);未启用自建时为 undefined,平台模式
        // 思考统一关闭:请求体固定带 thinking:false(忽略 opts.thinking),让服务端显式禁用
        body: JSON.stringify({ messages, ...opts, thinking: false, config: await getActiveRelayConfig() ?? undefined })
      })
    } catch (e) {
      if (signal?.aborted) throw new CancelledError()
      if ((e as Error)?.name === 'AbortError') throw timeoutError()
      throw e
    }
    if (!res.ok) {
      let message = `请求失败 (${res.status})`
      try {
        const err = await res.json() as { statusMessage?: string, message?: string }
        message = err.statusMessage || err.message || message
      } catch {
        // 非 JSON 错误体,保留默认文案
      }
      return { ok: false, status: res.status, message }
    }

    let usage: RelayedUsage | undefined
    let outputText = ''
    try {
      await readSseDataLines(res, (json) => {
        const chunk = parseUpstreamChunk(json)
        if (!chunk) return
        const delta = chunk.delta
        // 正文增量优先;content 为空但 reasoning_content 有内容时兜底(推理模型场景)
        const text = delta?.content || delta?.reasoning_content
        if (text) {
          outputText += text
          handlers.onDelta?.(text)
        }
        if (chunk.usage) {
          usage = mergeTokenUsage(usage, {
            promptTokens: chunk.usage.promptTokens ?? 0,
            completionTokens: chunk.usage.completionTokens ?? 0,
            totalTokens: chunk.usage.totalTokens ?? 0
          })
          handlers.onUsage?.(usage)
        }
      })
    } catch (e) {
      if (signal?.aborted) throw new CancelledError()
      if ((e as Error)?.name === 'AbortError') throw timeoutError()
      throw e
    }
    usage = finalizeStreamUsage(usage, messages, outputText)
    handlers.onUsage?.(usage)
    return { usage, ok: true }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** 读取 SSE 流并按 data: 行回调 */
export async function readSseDataLines(res: Response, onData: (json: string) => void): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const feed = makeDataLineParser(onData)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    feed(decoder.decode(value, { stream: true }))
  }
  feed(decoder.decode()) // 尾部残留
}

/** JSON 模式调用:累积内容并抽取 JSON。失败返回 {ok:false};解析失败返回 {ok:false, 502}。
 *  失败响应也带 usage(502 非 JSON 时输出已产生,调用方需如实入账) */
export async function aiChatJson<T = unknown>(
  messages: { role: 'system' | 'user' | 'assistant', content: string }[],
  opts: Omit<AiChatOptions, 'json'> = {},
  handlers: { onLive?: (info: LiveTokenInfo) => void, signal?: AbortSignal } = {}
): Promise<{ ok: true, data: T, usage?: RelayedUsage } | { ok: false, status: number, message: string, usage?: RelayedUsage }> {
  let buffer = ''
  const startedAt = Date.now()
  let lastEmit = 0
  // 输入在整个流式过程中固定不变:调用前一次性估算 prompt,实时展示 = 输入 + 已流出输出。
  // 只算输出的话,提取这类"大输入小输出"的调用会远低于真实消耗。
  const promptTokens = estimateMessagesTokens(messages)
  const emitLive = (force = false) => {
    if (!handlers.onLive) return
    const now = Date.now()
    if (!force && now - lastEmit < 150) return
    lastEmit = now
    const elapsedMs = now - startedAt
    const tokens = promptTokens + estimateTextTokens(buffer)
    handlers.onLive({
      tokens,
      speed: elapsedMs > 0 ? Math.round((tokens / elapsedMs) * 1000) : 0,
      elapsedMs
    })
  }
  emitLive(true)
  const waitTimer = setInterval(() => emitLive(true), 1000)
  let res: Awaited<ReturnType<typeof aiChat>>
  try {
    res = await aiChat(messages, { ...opts, json: true }, {
      onDelta: (d) => {
        buffer += d
        emitLive()
      }
    }, handlers.signal)
  } finally {
    clearInterval(waitTimer)
  }
  if (!res.ok) return { ok: false, status: res.status, message: res.message }
  const data = extractJson<T>(buffer)
  if (data === null) {
    // 报错附带输出长度与开头预览,便于排查非法 JSON 是截断还是模型跑题(如围栏/前导文字)
    const head = buffer.trim().slice(0, 120)
    return { ok: false, status: 502, message: `AI 输出不是合法 JSON,请重试(输出 ${buffer.length} 字符${head ? `,开头:「${head}」` : ''})`, usage: res.usage }
  }
  return { ok: true, data, usage: res.usage }
}
