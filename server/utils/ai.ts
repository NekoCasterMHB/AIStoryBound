// server/utils/ai.ts
// LLM 网关:统一封装"对话补全 / 流式 / 结构化输出"。
// 网关契约 = OpenAI-compatible chat/completions(OpenAI / DeepSeek / Moonshot / Groq / 本地 vLLM·Ollama 均可直接对接)。
// Anthropic 等非兼容服务端通过"网关适配器"扩展(见 provider 注释)。
// 认证:本地 dev / 部署统一从 event.context.cloudflare.env 读取 AI_API_KEY / AI_BASE_URL / AI_MODEL
//       (wrangler secret 或 wrangler.toml [vars]),并在 runtimeConfig.ai 提供构建期默认值兜底。
import type { H3Event } from 'h3'

export type AiRole = 'system' | 'user' | 'assistant'

export interface AiMessage {
  role: AiRole
  content: string
}

export interface AiConfig {
  /** OpenAI 兼容的 base URL,含 /v1,如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 直接透传 Authorization: Bearer <apiKey> */
  apiKey: string
  /** 默认模型名 */
  model: string
  /** 供应商标识(预留):openai 为默认;仍走同一协议 */
  provider: 'openai'
}

export interface ChatOptions {
  /** 覆盖默认模型 */
  model?: string
  temperature?: number
  maxTokens?: number
  /** 请求结构化输出(OpenAI 兼容的 response_format json_object) */
  json?: boolean
  /** 附加的请求头(如 provider 特殊字段) */
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface ChatResult {
  content: string
  /** 完整原始响应(供调试/扩展) */
  raw: unknown
  usage?: ChatUsage
}

/** 从 runTime 配置与 Worker env 绑定合并出 AI 配置(env 优先级更高) */
export function getAiConfig(event: H3Event): AiConfig {
  const rt = useRuntimeConfig(event).ai as Partial<AiConfig> | undefined
  const env = (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env

  const baseUrl = env?.AI_BASE_URL || rt?.baseUrl || 'https://api.openai.com/v1'
  const apiKey = env?.AI_API_KEY || rt?.apiKey || ''
  const model = env?.AI_MODEL || rt?.model || 'gpt-4o-mini'

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''), // 去掉尾部斜杠,便于拼接 /chat/completions
    apiKey,
    model,
    provider: 'openai'
  }
}

function timeoutSignal(timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs) return undefined
  return AbortSignal.timeout(timeoutMs)
}

/** 借助传入 signal + 可选 timeout 生成最终 AbortSignal */
function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  const c = new AbortController()
  const abort = () => c.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return c.signal
}

function assertConfigured(cfg: AiConfig) {
  if (!cfg.apiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'AI 未配置:缺少 API Key。请设置 AI_API_KEY(本地 .dev.vars / wrangler secret)'
    })
  }
}

/** 非流式对话补全,返回助手消息文本 */
export async function chatCompletion(event: H3Event, messages: AiMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const cfg = getAiConfig(event)
  assertConfigured(cfg)

  const body: Record<string, unknown> = {
    model: opts.model ?? cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    stream: false
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  if (opts.json) body.response_format = { type: 'json_object' }

  const signal = combineSignals(opts.signal, timeoutSignal(opts.timeoutMs))

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
      ...opts.headers
    },
    body: JSON.stringify(body),
    signal
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw createError({
      statusCode: 502,
      statusMessage: `AI 请求失败 (${res.status} ${res.statusText}): ${detail.slice(0, 400)}`
    })
  }

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }
  }
  const content: string = data.choices?.[0]?.message?.content ?? ''
  const usage = data?.usage
  return {
    content,
    raw: data,
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens }
      : undefined
  }
}

/**
 * 流式对话补全,返回上游 Response(可直接由 Nitro handler 返回给客户端做 SSE 代理)。
 * 流内容是 OpenAI 兼容的 SSE:`data: {...}` 分片,`data: [DONE]` 结束,发给客户端时按原样透传。
 */
export async function streamChat(event: H3Event, messages: AiMessage[], opts: ChatOptions = {}): Promise<Response> {
  const cfg = getAiConfig(event)
  assertConfigured(cfg)

  const body: Record<string, unknown> = {
    model: opts.model ?? cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    stream: true
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  if (opts.json) body.response_format = { type: 'json_object' }

  const signal = combineSignals(opts.signal, timeoutSignal(opts.timeoutMs))

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
      ...opts.headers
    },
    body: JSON.stringify(body),
    signal
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw createError({
      statusCode: 502,
      statusMessage: `AI 流式请求失败 (${res.status}): ${detail.slice(0, 400)}`
    })
  }
  return res
}

// ---- 结构化输出辅助 ----

/** 从模型返回文本里抽取 JSON:优先取 ```json 围栏,否则剥离前导/尾部文本后 JSON.parse */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = (fenced && fenced[1] ? fenced[1] : text)
    .replace(/^[\s\S]*?(\[|\{|")\s*/s, (_m, c) => c) // 去掉 JSON 之前的说明文字
    .trim()
  // 去掉 JSON 之后可能的解释文字(尝试平衡)
  try {
    return JSON.parse(candidate) as T
  } catch {
    // 尝试截断尾部非 JSON 内容
    const inner = tryParseAfter(candidate)
    if (inner !== undefined) return inner as T
    return null
  }
}

function tryParseAfter(text: string): unknown | undefined {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1]
      if (top && ((top === '{' && ch === '}') || (top === '[' && ch === ']'))) {
        stack.pop()
        if (stack.length === 0) {
          try {
            return JSON.parse(text.slice(0, i + 1))
          } catch {
            return undefined
          }
        }
      }
    }
  }
  return undefined
}

/**
 * 请求模型输出指定 JSON,解析并(可选)通过 validate 校验。
 * 失败时自动重试 maxRetries 次,仍失败抛 502。
 */
export async function structuredOutput<T>(
  event: H3Event,
  messages: AiMessage[],
  opts: {
    /** JSON 说明(格式要求)注入到 system 指令 */
    schemaHint: string
    model?: string
    temperature?: number
    maxTokens?: number
    /** 解析后的自定义校验,返回错误信息则视为失败 */
    validate?: (data: unknown) => string | null
    maxRetries?: number
    timeoutMs?: number
  }
): Promise<T> {
  const systemHint: AiMessage = {
    role: 'system',
    content: `你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。\n输出结构必须满足:\n${opts.schemaHint}`
  }
  const retries = Math.max(0, opts.maxRetries ?? 2)

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await chatCompletion(event, [systemHint, ...messages], {
      model: opts.model,
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens,
      json: true,
      timeoutMs: opts.timeoutMs
    })

    const parsed = extractJson<T>(res.content)
    if (parsed !== null) {
      const err = opts.validate?.(parsed)
      if (!err) return parsed
      if (attempt < retries) {
        // 把错误回灌给模型让其修正
        messages.push({ role: 'user', content: `解析结果不符合要求:${err}\n请重新输出修正后的 JSON。` })
        continue
      }
      throw createError({ statusCode: 502, statusMessage: `AI 输出校验失败: ${err}` })
    }

    if (attempt < retries) {
      messages.push({ role: 'user', content: '你的上一条输出不是合法 JSON,请仅重新输出一个合法 JSON 对象。' })
    }
  }

  throw createError({ statusCode: 502, statusMessage: 'AI 多次尝试后仍无法输出合法 JSON' })
}
