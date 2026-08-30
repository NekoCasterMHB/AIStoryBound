// 管理员查看平台 AI 配置列表(apiKey 只回显后 4 位 hint,密文永不出库)+ 当前生效配置及来源。
import { desc } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { getAiConfig, getEnvConfig, getAiPurposeRouting } from '../../../utils/ai'
import { aiProviderConfigs } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const rows = await useD1(event).select()
    .from(aiProviderConfigs)
    .orderBy(desc(aiProviderConfigs.createdAt))
    .all()

  const ai = await getAiConfig(event)
  // 环境变量兜底配置作为列表里的一个可选行展示(不含 key 本体,只带是否已配置)
  const env = getEnvConfig(event)
  // 用途模型路由:各用途(生成世界/对话)当前指向的配置行 id(null=跟随当前生效配置)
  const routing = await getAiPurposeRouting(event)

  return {
    configs: rows.map(r => ({
      id: r.id,
      name: r.name,
      format: r.format,
      baseUrl: r.baseUrl,
      model: r.model,
      apiKeyHint: r.apiKeyHint,
      active: r.active === 1,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime()
    })),
    effective: {
      /** db=库内启用配置,env=环境变量兜底 */
      source: ai.source,
      name: ai.name ?? null,
      model: ai.model,
      baseUrl: ai.baseUrl
    },
    routing: {
      worldGen: routing.worldGen ?? null,
      chat: routing.chat ?? null
    },
    env: {
      model: env.model,
      baseUrl: env.baseUrl,
      /** 环境变量是否配置了 key(未配置时切换过去会导致 AI 调用失败,前端禁用该开关) */
      hasKey: !!env.apiKey
    }
  }
})
