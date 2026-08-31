// server/utils/ai.ts
// LLM 网关(精简版):浏览器侧编排(生成管线/游戏回合)经 /api/ai/chat 中继转发,
// 这里只保留服务端自身的配置读取与 JSON 抽取工具(旧的上游直连封装已随旧编排移除)。
// 配置来源(优先级从高到低):
//   1. 管理员后台维护的平台配置(ai_provider_configs 表 active=1,apiKey AES-GCM 加密落库,见 /admin/ai-config);
//   2. 环境变量兜底 AI_BASE_URL / AI_API_KEY / AI_MODEL
//      (wrangler secret / wrangler.toml [vars],runtimeConfig.ai 提供构建期默认值)——库内无启用配置时行为与旧版一致。
import type { H3Event } from 'h3'
import { asc, eq } from 'drizzle-orm'
import { extractJson } from '../../shared/json'
import { aiProviderConfigs } from '../db/schema'
import { useD1 } from './d1'
import { decryptJson } from './crypto'
import { getAppConfig } from './config'
import { isAiApiFormat, type AiApiFormat, AI_ROUTE_ENV } from '../../shared/ai-config'

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

/** AI 调用用途:'worldGen'=生成世界流水线(提取/检查/成书/作者识别), 'chat'=对话类(缺省) */
export type AiPurpose = 'worldGen' | 'chat'

/** app_config 表里存用途路由的 key:JSON { worldGen: 配置行id|null, chat: 配置行id|null } */
export const AI_PURPOSE_ROUTING_KEY = 'ai_purpose_routing'

type AiProviderConfigRow = typeof aiProviderConfigs.$inferSelect

/** 配置行 → AiConfig(解密 apiKey;行缺失字段或解密失败返回 null) */
async function rowToAiConfig(event: H3Event, row: AiProviderConfigRow): Promise<AiConfig | null> {
  if (!row.baseUrl || !row.model) return null
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

/** 从 D1 取当前启用的平台配置:可多行同时启用(作为用途路由的候选),未路由用途按创建时间取最早的一条;无启用行返回 null */
async function getActiveDbConfig(event: H3Event): Promise<AiConfig | null> {
  const row = await useD1(event).select()
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.active, 1))
    .orderBy(asc(aiProviderConfigs.createdAt))
    .limit(1)
    .get()
  if (!row) return null
  return rowToAiConfig(event, row)
}

/** 按 id 取指定配置行(用途路由用) */
async function getDbConfigById(event: H3Event, id: string): Promise<AiConfig | null> {
  const row = await useD1(event).select()
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.id, id))
    .get()
  if (!row) return null
  return rowToAiConfig(event, row)
}

/** 读取用途路由映射(缺失/解析失败按空映射处理,全部用途走默认链) */
async function getPurposeRouting(event: H3Event): Promise<Partial<Record<AiPurpose, string | null>>> {
  try {
    const raw = await getAppConfig(useD1(event), AI_PURPOSE_ROUTING_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Partial<Record<AiPurpose, string | null>> : {}
  } catch {
    return {}
  }
}

/** 从 runTime 配置与 Worker env 绑定合并出 AI 配置(env 优先级更高)。
 *  导出供管理员后台展示"环境变量"这一备选项(切换回 env 兜底用);key 不出此函数边界以外的地方使用 */
export function getEnvConfig(event: H3Event): AiConfig {
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

/** 读取当前生效的 AI 配置:用途路由命中时用该指向(配置行或环境变量),否则按默认链(库内 active=1 中最早创建的 → 环境变量兜底)。
 *  路由指向的行已删除/无效时静默回落默认链(悬空引用由删除接口负责清理,这里只兜底)。 */
export async function getAiConfig(event: H3Event, purpose: AiPurpose = 'chat'): Promise<AiConfig> {
  const routing = await getPurposeRouting(event)
  const id = routing[purpose]
  if (id === AI_ROUTE_ENV) {
    return getEnvConfig(event)
  }
  if (id) {
    const byId = await getDbConfigById(event, id)
    if (byId) return byId
  }
  return (await getActiveDbConfig(event)) ?? getEnvConfig(event)
}

/** 读取用途路由映射(管理员接口回显用) */
export async function getAiPurposeRouting(event: H3Event): Promise<Partial<Record<AiPurpose, string | null>>> {
  return getPurposeRouting(event)
}

// ---- 结构化输出辅助 ----

export { extractJson }
