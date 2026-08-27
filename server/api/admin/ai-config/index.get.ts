// 管理员查看平台 AI 配置列表(apiKey 只回显后 4 位 hint,密文永不出库)+ 当前生效配置及来源。
import { desc } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { getAiConfig } from '../../../utils/ai'
import { aiProviderConfigs } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const rows = await useD1(event).select()
    .from(aiProviderConfigs)
    .orderBy(desc(aiProviderConfigs.createdAt))
    .all()

  const ai = await getAiConfig(event)

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
    }
  }
})
