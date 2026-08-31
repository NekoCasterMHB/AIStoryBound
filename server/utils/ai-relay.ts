// server/utils/ai-relay.ts
// 用户自建 AI 配置的三种 API 格式适配:
//  - chat     : Chat Completions(/chat/completions),原样透传 SSE
//  - anthropic: Anthropic Messages(/v1/messages,x-api-key),流式事件翻译为 OpenAI 兼容 SSE
//  - responses: OpenAI Responses(/responses),流式事件翻译同上
// 浏览器端 aiRelay 只认 OpenAI 兼容 SSE,因此上游差异在此收敛。
import type { AiApiFormat } from '../../shared/ai-config'
import type { TokenUsage } from '../../shared/novel'
import {
  estimateMessagesTokens,
  estimateTextTokens,
  finalizeStreamUsage,
  mergeTokenUsage,
  normalizeTokenUsage,
  type NormalizedTokenUsage
} from '../../shared/token-estimate'

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
  /** 思考开关:所有调用统一传 false(关闭)。chat 格式显式发送 thinking:{type:'disabled'} 强制关闭 */
  thinking?: boolean
  stream?: boolean
}

interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 按格式构建上游请求(stream=false 用于测试连接/非流式)。思考(thinking)统一关闭:调用方固定传 false。 */
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
      // Anthropic Messages 必填 max_tokens;未指定时用高上限,不再硬填 4096 截断完整提取/成书
      max_tokens: input.maxTokens && input.maxTokens > 0 ? input.maxTokens : 32768,
      messages
    }
    if (input.stream) body.stream = true
    if (input.temperature !== undefined) body.temperature = input.temperature
    // Anthropic 思考关闭即不发 thinking 字段(缺省不开启);开启才显式设置
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
    // Responses 思考关闭即不发 reasoning 字段(缺省不开启);开启才显式设置
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
  // chat 格式必须显式带 thinking 字段:DeepSeek 等模型默认可能开启思考,
  // 不传等于让模型自行决定;传 {type:'disabled'} 才是明确关闭。
  // OpenRouter 关思考认 reasoning 而非 thinking,两者都发:OpenRouter 读 reasoning,
  // DeepSeek 官方读 thinking,其它供应商忽略未知字段(不按供应商区分)。
  if (input.thinking !== undefined) {
    body.thinking = { type: input.thinking ? 'enabled' : 'disabled' }
    body.reasoning = { enabled: input.thinking }
  }
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
  /**
   * 流结束后 resolve 的上游用量。上游正常给出 usage 时用真实值;
   * 流被取消/中断或上游未返回 usage 时,按已转发的消息与输出内容估算
   * (与前端实时估算同一套 shared/token-estimate 口径),保证取消的请求也能如实扣费。
   */
  usage: Promise<TokenUsage>
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

/** 估算兜底:输入按 messages 估算,输出按已流出的文本估算(与客户端实时口径一致) */
function estimateUsage(
  messages: { role: string, content: string }[],
  outputText: string
): TokenUsage {
  const promptTokens = estimateMessagesTokens(messages)
  const completionTokens = estimateTextTokens(outputText)
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

/**
 * 上游流空闲超时:请求级 timeoutMs(AbortSignal.timeout)在 fetch 拿到响应头后就失效,
 * 若上游在流中途挂起/断流不关连接,reader.read() 会永久挂起,前端进度就卡死。
 * 这里对 body 读取兜底:有数据即重置计时(慢生成不受影响),连续无数据超时则主动断开。
 */
const RELAY_IDLE_TIMEOUT_MS = 120_000

/** 带空闲超时的上游读取:有数据重置计时,连续 RELAY_IDLE_TIMEOUT_MS 无数据则 reject */
async function readUpstream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`上游流 ${RELAY_IDLE_TIMEOUT_MS / 1000}s 无数据,判定挂起`)), RELAY_IDLE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([reader.read(), idle])
  } finally {
    clearTimeout(timer)
  }
}

export async function relaySse(
  cfg: RelayTarget,
  upstream: Response,
  messages: { role: string, content: string }[] = []
): Promise<RelayStreamResult> {
  const reader = upstream.body?.getReader()

  // Chat Completions:原样透传字节,同时按行解析 usage(跨分片合并,不锁第一帧)
  if (cfg.format === 'chat' && reader) {
    let usagePromiseResolve: (u: TokenUsage) => void = () => {}
    const usage = new Promise<TokenUsage>((resolve) => {
      usagePromiseResolve = resolve
    })
    /** 已转发的输出文本(取消/无 usage 时估算兜底) */
    let outputText = ''
    let mergedUsage: NormalizedTokenUsage | undefined
    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (!reader) {
          controller.close()
          usagePromiseResolve(estimateUsage(messages, ''))
          return
        }
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await readUpstream(reader)
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
                  choices?: { delta?: { content?: string } }[]
                  usage?: Record<string, unknown>
                }
                if (d.usage) {
                  mergedUsage = mergeTokenUsage(mergedUsage, normalizeTokenUsage(d.usage))
                }
                const delta = d.choices?.[0]?.delta?.content
                if (typeof delta === 'string' && delta) outputText += delta
              } catch {
                // 非 JSON 分片忽略
              }
            }
          }
          controller.close()
        } catch (e) {
          controller.error(e)
        } finally {
          usagePromiseResolve(finalizeStreamUsage(mergedUsage, messages, outputText))
        }
      }
    })
    return { sse, usage }
  }

  // Anthropic / Responses:解析上游事件并重新拼装 OpenAI 兼容 SSE
  let usageResolve: (u: TokenUsage) => void = () => {}
  const usage = new Promise<TokenUsage>((resolve) => {
    usageResolve = resolve
  })

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!reader) {
        controller.close()
        usageResolve(estimateUsage(messages, ''))
        return
      }
      let buf = ''
      let prompt = 0
      let completion = 0
      let done = false
      /** 已转发的输出文本(估算兜底用) */
      let outputText = ''
      const emit = (s: string) => controller.enqueue(encoder.encode(s))
      const finish = () => {
        if (done) return
        done = true
        if (prompt > 0 || completion > 0) emit(emitUsage(prompt, completion))
        emit('data: [DONE]\n\n')
        // 上游事件带 usage 用真实值;缺省(0/0)按已转发内容估算兜底;一边缺失时补估算
        usageResolve(finalizeStreamUsage(
          prompt > 0 || completion > 0
            ? { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }
            : undefined,
          messages,
          outputText
        ))
      }
      try {
        for (;;) {
          const { done: d, value } = await readUpstream(reader)
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
                  if (delta?.type === 'text_delta' && delta.text) {
                    emit(emitData(delta.text))
                    outputText += delta.text
                  }
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
                  outputText += d.delta
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
        if (!done) usageResolve(estimateUsage(messages, outputText))
      }
    }
  })
  return { sse, usage }
}

/** 把文本中出现的 apiKey 替换为 ***,防止上游错误信息回显 key 时泄露给前端 */
export function maskApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text
  return text.split(apiKey).join('***')
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
      return { ok: false, message: `连接失败 (HTTP ${res.status}): ${maskApiKey(detail.slice(0, 200), cfg.apiKey)}` }
    }
    return { ok: true, message: '连接成功' }
  } catch (e) {
    return { ok: false, message: `连接异常: ${(e as Error).message}` }
  }
}
