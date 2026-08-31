// 管理员删除平台 AI 配置(删除后该行从路由候选中消失;系统按路由/启用链回落,无启用行时回退环境变量)。
// 被用途模型路由使用的配置阻止删除(先在路由中改选),避免悬空引用。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { aiProviderConfigs } from '../../../db/schema'
import { getAiPurposeRouting } from '../../../utils/ai'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  }

  const db = useD1(event)
  const rows = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).all()
  const row = rows[0]
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: '配置不存在' })
  }

  // 被路由使用的配置阻止删除
  const routing = await getAiPurposeRouting(event)
  const usedBy = [
    routing.worldGen === id ? '生成世界' : null,
    routing.chat === id ? '对话' : null
  ].filter(Boolean).join('、')
  if (usedBy) {
    throw createError({
      statusCode: 409,
      statusMessage: `该配置正被用途路由使用(${usedBy}),请先在「用途模型路由」中改选后再删除`
    })
  }

  await db.delete(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).run()
  return { ok: true }
})
