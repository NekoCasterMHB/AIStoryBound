// server/utils/ai.ts
// LLM 网关(精简版):浏览器侧编排(生成管线/游戏回合)经 /api/ai/chat 中继转发,
// 这里只保留服务端自身的配置读取与 JSON 抽取工具(旧的上游直连封装已随旧编排移除)。
// 认证/配置:本地 dev / 部署统一从 event.context.cloudflare.env 读取 AI_API_KEY / AI_BASE_URL / AI_MODEL
//       (wrangler secret / wrangler.toml [vars]),并在 runtimeConfig.ai 提供构建期默认值兜底。
import type { H3Event } from 'h3'
import { extractJson } from '../../shared/json'

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

// ---- 结构化输出辅助 ----

export { extractJson }
