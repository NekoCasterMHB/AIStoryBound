// server/utils/ai-relay.ts
// 用户自建 AI 配置的三种 API 格式适配:
//  - chat     : Chat Completions(/chat/completions),原样透传 SSE
//  - anthropic: Anthropic Messages(/v1/messages,x-api-key),流式事件翻译为 OpenAI 兼容 SSE
//  - responses: OpenAI Responses(/responses),流式事件翻译同上
// 浏览器端 aiRelay 只认 OpenAI 兼容 SSE,因此上游差异在此收敛。
import type { AiApiFormat } from '../../shared/ai-config'
import type { TokenUsage } from '../../shared/novel'

export interface RelayTarget {
  format: AiApiFormat
  /** 供应商 baseUrl(不带尾部斜杠,不含路径) */
  baseUrl: string
  apiKey: string
  model: string
}

export interface RelayInput {
  messages: { role: 'system' | 'user' | 'assistant', content: string }[]
  json?: boolean
  maxTokens?: number
  temperature?: number
  thinking?: boolean
  stream?: boolean
}

interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 按格式构建上游请求(stream=false 用于测试连接/非流式) */
export function buildUpstreamRequest(cfg: RelayTarget, input: RelayInput): UpstreamRequest {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const json = input.json ?? false
  const thinking = input.thinking ?? false

  if (cfg.format === 'anthropic') {
    const system = input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const messages = input.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: input.maxTokens ?? 4096,
      messages
    }
    if (input.stream) body.stream = true
    if (input.temperature !== undefined) body.temperature = input.temperature
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: 1024 }
    if (json) {
      // Anthropic 无 response_format,在 system 里要求纯 JSON,前端仍用 extractJson 兜底
      body.system = `${system ? system + '\n\n' : ''}Always respond with valid JSON only, without markdown code fences.`
    } else if (system) {
      body.system = system
    }
    return {
      url: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body
    }
  }

  if (cfg.format === 'responses') {
    const system = input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const inputItems = input.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    const body: Record<string, unknown> = {
      model: cfg.model,
      input: inputItems
    }
    if (input.stream) body.stream = true
    if (input.maxTokens) body.max_output_tokens = input.maxTokens
    if (input.temperature !== undefined) body.temperature = input.temperature
    if (system) body.instructions = system
    if (json) body.text = { format: { type: 'json_object' } }
    if (thinking) body.reasoning = { effort: 'high' }
    return {
      url: `${base}/responses`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body
    }
  }

  // chat(默认):Chat Completions
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: input.messages,
    temperature: input.temperature ?? 0.7
  }
  if (input.stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }
  if (json) body.response_format = { type: 'json_object' }
  if (input.maxTokens) body.max_tokens = input.maxTokens
  if (input.thinking !== undefined) body.thinking = { type: input.thinking ? 'enabled' : 'disabled' }
  return {
    url: `${base}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`
    },
    body
  }
}

/** 抽取上游流式内容并翻译成 OpenAI 兼容 SSE。用全局(不被依赖的)解析器避免闭包膨胀。 */
export interface RelayStreamResult {
  /** OpenAI 兼容 SSE 字节流(含流尾 usage 分片与 [DONE]) */
  sse: ReadableStream<Uint8Array>
  /** 流结束后 resolve 的上游用量;解析失败为 null */
  usage: Promise<TokenUsage | null>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function emitData(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

function emitUsage(prompt: number, completion: number): string {
  return `data: ${JSON.stringify({
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  })}\n\n`
}

export async function relaySse(cfg: RelayTarget, upstream: Response): Promise<RelayStreamResult> {
  const reader = upstream.body?.getReader()

  // Chat Completions:原样透传字节,同时按行解析流尾 usage
  if (cfg.format === 'chat' && reader) {
    let usagePromiseResolve: (u: TokenUsage | null) => void = () => {}
    const usage = new Promise<TokenUsage | null>((resolve) => {
      usagePromiseResolve = resolve
    })
    let usageResolved = false
    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (!reader) {
          controller.close()
          return
        }
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
            buf += decoder.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line.startsWith('data:')) continue
              const json = line.slice(5).trim()
              if (json === '[DONE]' || !json) continue
              try {
                const d = JSON.parse(json) as {
                  usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }
                }
                if (d.usage?.total_tokens && !usageResolved) {
                  usageResolved = true
                  usagePromiseResolve({
                    promptTokens: d.usage.prompt_tokens ?? 0,
                    completionTokens: d.usage.completion_tokens ?? 0,
                    totalTokens: d.usage.total_tokens
                  })
                }
              } catch {
                // 非 JSON 分片忽略
              }
            }
          }
          controller.close()
        } catch (e) {
          controller.error(e)
        } finally {
          if (!usageResolved) usagePromiseResolve(null)
        }
      }
    })
    return { sse, usage }
  }

  // Anthropic / Responses:解析上游事件并重新拼装 OpenAI 兼容 SSE
  let usageResolve: (u: TokenUsage | null) => void = () => {}
  const usage = new Promise<TokenUsage | null>((resolve) => {
    usageResolve = resolve
  })

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!reader) {
        controller.close()
        usageResolve(null)
        return
      }
      let buf = ''
      let prompt = 0
      let completion = 0
      let done = false
      const emit = (s: string) => controller.enqueue(encoder.encode(s))
      const finish = () => {
        if (done) return
        done = true
        if (prompt > 0 || completion > 0) emit(emitUsage(prompt, completion))
        emit('data: [DONE]\n\n')
        usageResolve({ promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion })
      }
      try {
        for (;;) {
          const { done: d, value } = await reader.read()
          if (d) break
          buf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const json = line.slice(5).trim()
            if (!json) continue
            if (json === '[DONE]') {
              finish()
              continue
            }
            try {
              const d = JSON.parse(json) as Record<string, unknown>
              if (cfg.format === 'anthropic') {
                const type = d.type
                if (type === 'content_block_delta') {
                  const delta = d.delta as { type?: string, text?: string } | undefined
                  if (delta?.type === 'text_delta' && delta.text) emit(emitData(delta.text))
                } else if (type === 'message_start') {
                  const usageInfo = (d.message as { usage?: { input_tokens?: number } } | undefined)?.usage
                  if (usageInfo?.input_tokens) prompt = usageInfo.input_tokens
                } else if (type === 'message_delta') {
                  const usageInfo = d.usage as { output_tokens?: number } | undefined
                  if (usageInfo?.output_tokens) completion = usageInfo.output_tokens
                } else if (type === 'message_stop') {
                  finish()
                }
                // 'error' 事件:HTTP 已是 200 的罕见场景,直接结束流
              } else {
                // responses
                const type = d.type
                if (type === 'response.output_text.delta' && typeof d.delta === 'string') {
                  emit(emitData(d.delta))
                } else if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
                  const usageInfo = (d.response as { usage?: { input_tokens?: number, output_tokens?: number } } | undefined)?.usage
                  if (usageInfo) {
                    if (usageInfo.input_tokens) prompt = usageInfo.input_tokens
                    if (usageInfo.output_tokens) completion = usageInfo.output_tokens
                  }
                  finish()
                }
              }
            } catch {
              // 非 JSON 分片忽略
            }
          }
        }
        finish()
        controller.close()
      } catch (e) {
        controller.error(e)
        usageResolve(null)
      }
    }
  })
  return { sse, usage }
}

/** 发送一条非流式测试请求(三种格式通用),返回可读结果 */
export async function testRelay(cfg: RelayTarget): Promise<{ ok: boolean, message: string }> {
  try {
    const req = buildUpstreamRequest(cfg, {
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
      temperature: 0,
      stream: false
    })
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30_000)
    })
    const detail = await res.text().catch(() => '')
    if (!res.ok) {
      return { ok: false, message: `连接失败 (HTTP ${res.status}): ${detail.slice(0, 200)}` }
    }
    return { ok: true, message: '连接成功' }
  } catch (e) {
    return { ok: false, message: `连接异常: ${(e as Error).message}` }
  }
}
