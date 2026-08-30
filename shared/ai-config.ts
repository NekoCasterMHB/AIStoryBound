// shared/ai-config.ts
// 自建 AI 配置的 API 格式定义(客户端与服务器共用)。
// 当前主流三种:Chat Completions(/chat/completions)、Anthropic Messages(/v1/messages)、Responses(/responses)。
export type AiApiFormat = 'chat' | 'anthropic' | 'responses'

// ---- AI 中继超时(客户端生成参数与服务端 /api/ai/chat 共用,避免两侧常量漂移) ----
/** 默认单次中继超时(毫秒):覆盖 32K tokens 输出在常见速度(50~60 tok/s)下的耗时 */
export const RELAY_TIMEOUT_DEFAULT_MS = 600_000
/** 中继超时可配置下限(毫秒) */
export const RELAY_TIMEOUT_MIN_MS = 30_000
/** 中继超时可配置上限(毫秒):太大拖住上游连接,Worker 侧也易被掐断 */
export const RELAY_TIMEOUT_MAX_MS = 900_000

export interface AiApiFormatMeta {
  value: AiApiFormat
  /** 展示名 */
  label: string
  /** 一句话说明(选择器帮助文案) */
  desc: string
  /** baseUrl 输入框占位/默认值 */
  defaultBaseUrl: string
  /** 模型名占位 */
  placeholderModel: string
}

export const AI_API_FORMATS: AiApiFormatMeta[] = [
  {
    value: 'chat',
    label: 'Chat Completions',
    desc: 'OpenAI 标准 /chat/completions 接口,DeepSeek、通义、智谱及各类中转站通用',
    defaultBaseUrl: 'https://api.openai.com/v1',
    placeholderModel: 'gpt-4o-mini'
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    desc: 'Claude 官方 /v1/messages 接口(x-api-key 认证)',
    defaultBaseUrl: 'https://api.anthropic.com',
    placeholderModel: 'claude-sonnet-4-20250514'
  },
  {
    value: 'responses',
    label: 'Responses',
    desc: 'OpenAI 新一代 /responses 接口',
    defaultBaseUrl: 'https://api.openai.com/v1',
    placeholderModel: 'gpt-4.1-mini'
  }
]

/** 每用户自建配置数量上限(前端「最多可保存 N 套配置」与服务端验证记录滚动保留共用) */
export const AI_USER_CONFIG_LIMIT = 5

export function aiFormatMeta(format: AiApiFormat): AiApiFormatMeta {
  return AI_API_FORMATS.find(f => f.value === format) ?? AI_API_FORMATS[0]!
}

export function isAiApiFormat(v: unknown): v is AiApiFormat {
  return v === 'chat' || v === 'anthropic' || v === 'responses'
}

/** 用途模型路由中「环境变量(部署默认)」的哨兵值:与配置行 id 一样可作为某用途的指向 */
export const AI_ROUTE_ENV = '__env__'
