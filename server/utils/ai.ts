// server/utils/ai.ts
// LLM 网关(精简版):浏览器侧编排(生成管线/游戏回合)经 /api/ai/chat 中继转发,
// 这里只保留服务端自身的配置读取与 JSON 抽取工具(旧的上游直连封装已随旧编排移除)。
// 配置来源(优先级从高到低):
//   1. 管理员后台维护的平台配置(ai_provider_configs 表 active=1,apiKey AES-GCM 加密落库,见 /admin/ai-config);
//   2. 环境变量兜底 AI_BASE_URL / AI_API_KEY / AI_MODEL
//      (wrangler secret / wrangler.toml [vars],runtimeConfig.ai 提供构建期默认值)——库内无启用配置时行为与旧版一致。
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { extractJson } from '../../shared/json'
import { aiProviderConfigs } from '../db/schema'
import { useD1 } from './d1'
import { decryptJson } from './crypto'
import { isAiApiFormat, type AiApiFormat } from '../../shared/ai-config'

export interface AiConfig {
  /** OpenAI 兼容的 base URL,含 /v1,如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 直接透传 Authorization: Bearer <apiKey> */
  apiKey: string
  /** 默认模型名 */
  model: string
  /** API 格式(chat / anthropic / responses,见 shared/ai-config.ts) */
  format: AiApiFormat
  /** 配置展示名(库内配置时才有) */
  name?: string
  /** 配置来源:db=管理员后台配置,env=环境变量兜底 */
  source: 'db' | 'env'
}

/** 从 D1 取当前启用的平台配置(未启用/无有效 key 返回 null) */
async function getActiveDbConfig(event: H3Event): Promise<AiConfig | null> {
  const row = await useD1(event).select()
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.active, 1))
    .get()
  if (!row || !row.baseUrl || !row.model) return null
  const apiKey = await decryptJson<string>(event, row.apiKeyCiphertext, row.apiKeyIv)
  if (!apiKey) {
    console.error('[ai] 平台配置解密失败(密钥变更?),key 视为不可用:', row.name)
    return null
  }
  return {
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: row.model,
    format: isAiApiFormat(row.format) ? row.format : 'chat',
    name: row.name,
    source: 'db'
  }
}

/** 从 runTime 配置与 Worker env 绑定合并出 AI 配置(env 优先级更高) */
function getEnvConfig(event: H3Event): AiConfig {
  const rt = useRuntimeConfig(event).ai as Partial<AiConfig> | undefined
  const env = (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env

  const baseUrl = env?.AI_BASE_URL || rt?.baseUrl || 'https://api.openai.com/v1'
  const apiKey = env?.AI_API_KEY || rt?.apiKey || ''
  const model = env?.AI_MODEL || rt?.model || 'gpt-4o-mini'

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''), // 去掉尾部斜杠,便于拼接 /chat/completions
    apiKey,
    model,
    format: 'chat',
    source: 'env'
  }
}

/** 读取当前生效的 AI 配置:管理员后台配置(库内 active=1)优先,未配置时回退环境变量 */
export async function getAiConfig(event: H3Event): Promise<AiConfig> {
  return (await getActiveDbConfig(event)) ?? getEnvConfig(event)
}

// ---- 结构化输出辅助 ----

export { extractJson }
