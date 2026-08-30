// server/utils/ai-call.ts
// 服务端非交互 AI JSON 调用(云端世界生成管线用,区别于 /api/ai/chat 的浏览器编排中继):
//  - 复用 ai-relay 的请求构建与 SSE 翻译,统一 chat/anthropic/responses 三种上游格式;
//  - 必须走流式:上游网关对非流式请求有 ~100s 超时,长输出经常被掐断,流式不受该限制;
//  - 返回解析后的 JSON 与真实用量(usage 缺失时 relaySse 已按 shared/token-estimate 口径估算兜底)。
// 计费不在本模块:调用方(世界生成管线)按 keySource 决定预授权/退款或仅记账。
import { buildUpstreamRequest, relaySse, maskApiKey } from './ai-relay'
import type { RelayTarget } from './ai-relay'
import { extractJson } from '../../shared/json'
import type { TokenUsage } from '../../shared/novel'

export interface AiJsonCallOptions {
  messages: { role: 'system' | 'user' | 'assistant', content: string }[]
  maxTokens?: number
  temperature?: number
  /** 单次调用超时(毫秒);缺省 600s */
  timeoutMs?: number
}

export interface AiJsonCallResult {
  data: unknown
  usage: TokenUsage
}

/** 值得重试的瞬时错误:网络/解析异常、429 限流、5xx 上游错误 */
export function isRetryableError(e: unknown): boolean {
  const status = (e as { status?: number })?.status
  return status === undefined || status === 429 || status >= 500
}

/** 读取 OpenAI 兼容 SSE,累计 delta.content(relaySse 产物,含流尾 usage 分片与 [DONE]) */
async function consumeSseContent(sse: ReadableStream<Uint8Array>): Promise<string> {
  const reader = sse.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return content
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
          const delta = chunk.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta) content += delta
        } catch {
          // 跳过无法解析的分片
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return content
}

/**
 * 单次流式 AI 调用,输出解析为 JSON。
 * 非 JSON 输出/上游失败按可重试错误抛出(带 status 供 isRetryableError 判断)。
 */
export async function callAiJson(relay: RelayTarget, opts: AiJsonCallOptions): Promise<AiJsonCallResult> {
  const req = buildUpstreamRequest(relay, {
    messages: opts.messages,
    json: true,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    thinking: false,
    stream: true
  })
  let upstream: Response
  try {
    upstream = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000)
    })
  } catch (e) {
    throw new Error(`AI 上游请求失败: ${(e as Error).message}`, { cause: e })
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    const err = new Error(`AI 上游错误 (${upstream.status}): ${maskApiKey(detail.slice(0, 300), relay.apiKey)}`) as Error & { status?: number }
    err.status = upstream.status
    throw err
  }
  if (!upstream.body) throw new Error('上游未返回流式响应体')

  const { sse, usage } = await relaySse(relay, upstream, opts.messages)
  const content = await consumeSseContent(sse)
  const u = await usage
  const data = extractJson(content)
  if (data === null) {
    throw new Error('AI 返回非 JSON,已按失败处理')
  }
  return { data, usage: u }
}
