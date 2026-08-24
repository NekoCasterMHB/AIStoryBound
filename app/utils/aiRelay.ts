// app/utils/aiRelay.ts
// AI 中继浏览器客户端:统一封装 POST /api/ai/chat(SSE 流式)。
// - aiChat: 流式(回合叙事等),onDelta 逐片回调,返回总 usage
// - aiChatJson: 请求 json:true,累积所有 delta 后抽取 JSON(生成管线/选项结构化用)
import { extractJson } from '#shared/json'
import { getActiveRelayConfig } from './aiConfigStore'

export interface RelayedUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/** 实时估算信息(字符 → token,含速度;用于生成/回合期间实时消耗展示) */
export interface LiveTokenInfo {
  /** 当前这轮流式调用的估算 token 数(不含已入账的真实用量) */
  tokens: number
  /** tokens/秒(当前流) */
  speed: number
  elapsedMs: number
}

/** 粗略 token 估算(CJK 混排按 字符数/1.7;与旧版服务器估算一致,收尾以真实 usage 为准) */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 1.7))
}

export interface AiChatOptions {
  json?: boolean
  maxTokens?: number
  temperature?: number
  thinking?: boolean
}

/** 解析上游 SSE 的 data: 行(可能跨块,按行缓冲) */
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
 * 调用 AI 中继。返回 { usage } 与 { ok:false, message } 失败信息(402/502 等);
 * 网络层异常抛 Error。
 */
export async function aiChat(
  messages: { role: 'system' | 'user' | 'assistant', content: string }[],
  opts: AiChatOptions,
  handlers: {
    onDelta?: (delta: string) => void
    onUsage?: (usage: RelayedUsage) => void
  } = {}
): Promise<{ usage?: RelayedUsage, ok: true } | { ok: false, status: number, message: string }> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 浏览器本地自建配置随请求临时携带(不落库);未启用自建时为 undefined,平台模式
    body: JSON.stringify({ messages, ...opts, config: await getActiveRelayConfig() ?? undefined })
  })
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
  await readSseDataLines(res, (json) => {
    try {
      const d = JSON.parse(json) as {
        choices?: { delta?: { content?: string } }[]
        usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }
      }
      const delta = d.choices?.[0]?.delta?.content
      if (delta) handlers.onDelta?.(delta)
      if (d.usage) {
        usage = {
          promptTokens: d.usage.prompt_tokens,
          completionTokens: d.usage.completion_tokens,
          totalTokens: d.usage.total_tokens
        }
        handlers.onUsage?.(usage)
      }
    } catch {
      // 忽略非 JSON 分片
    }
  })
  return { usage, ok: true }
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

/** JSON 模式调用:累积内容并抽取 JSON。失败返回 {ok:false};解析失败返回 {ok:false, 502} */
export async function aiChatJson<T = unknown>(
  messages: { role: 'system' | 'user' | 'assistant', content: string }[],
  opts: Omit<AiChatOptions, 'json'> = {},
  handlers: { onLive?: (info: LiveTokenInfo) => void } = {}
): Promise<{ ok: true, data: T, usage?: RelayedUsage } | { ok: false, status: number, message: string }> {
  let buffer = ''
  const startedAt = Date.now()
  let lastEmit = 0
  const res = await aiChat(messages, { ...opts, json: true }, {
    onDelta: (d) => {
      buffer += d
      // 实时估算(节流 150ms),UI 显示"进行中消耗"
      const now = Date.now()
      if (handlers.onLive && now - lastEmit >= 150) {
        lastEmit = now
        const elapsedMs = now - startedAt
        handlers.onLive({
          tokens: estimateTokens(buffer.length),
          speed: elapsedMs > 0 ? Math.round((estimateTokens(buffer.length) / elapsedMs) * 1000) : 0,
          elapsedMs
        })
      }
    }
  })
  if (!res.ok) return res
  const data = extractJson<T>(buffer)
  if (data === null) {
    return { ok: false, status: 502, message: 'AI 输出不是合法 JSON,请重试' }
  }
  return { ok: true, data, usage: res.usage }
}
