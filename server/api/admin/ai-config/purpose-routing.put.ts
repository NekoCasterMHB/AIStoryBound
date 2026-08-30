// 管理员保存用途模型路由:每个用途(生成世界/对话)当前使用哪条配置行或环境变量。
// 多套配置统一存 ai_provider_configs 列表,这里只写"用途 → 指向"映射:
//   配置行 id | AI_ROUTE_ENV(环境变量)| null=跟随默认链(最早创建的启用配置 → env)。
// 存 app_config 表(key=ai_purpose_routing),不改配置行结构与 active 开关语义。
import { inArray } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { aiProviderConfigs } from '../../../db/schema'
import { AI_PURPOSE_ROUTING_KEY, getAiPurposeRouting } from '../../../utils/ai'
import { AI_ROUTE_ENV } from '../../../../shared/ai-config'
import { setAppConfig } from '../../../utils/config'

interface PurposeRoutingBody {
  worldGen?: string | null
  chat?: string | null
}

const PURPOSE_KEYS = ['worldGen', 'chat'] as const

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody<PurposeRoutingBody>(event).catch(() => ({} as PurposeRoutingBody))

  // 与现有路由合并:body 未提供的键保持不变,提供的键 id=null 表示清除(跟随默认)
  const prev = await getAiPurposeRouting(event)
  const next: Record<string, string | null> = {
    worldGen: prev.worldGen ?? null,
    chat: prev.chat ?? null
  }
  const requested: { key: typeof PURPOSE_KEYS[number], id: string }[] = []
  for (const key of PURPOSE_KEYS) {
    if (body[key] === undefined) continue
    if (body[key] == null) {
      next[key] = null
    } else {
      const id = String(body[key])
      next[key] = id
      requested.push({ key, id })
    }
  }

  // 校验指向的配置行存在,防止悬空引用(环境变量哨兵值无需校验)
  if (requested.length) {
    const ids = [...new Set(requested.map(r => r.id).filter(v => v !== AI_ROUTE_ENV))]
    const rows = ids.length
      ? await useD1(event).select({ id: aiProviderConfigs.id })
          .from(aiProviderConfigs)
          .where(inArray(aiProviderConfigs.id, ids))
          .all()
      : []
    const exist = new Set(rows.map(r => r.id))
    for (const { key, id } of requested) {
      if (id !== AI_ROUTE_ENV && !exist.has(id)) {
        throw createError({ statusCode: 400, statusMessage: `用途「${key}」指向的配置不存在` })
      }
    }
  }

  await setAppConfig(useD1(event), AI_PURPOSE_ROUTING_KEY, JSON.stringify(next))
  return { ok: true, routing: next }
})
