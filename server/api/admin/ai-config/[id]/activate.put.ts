// 管理员切换配置行的启用状态(开关语义,可多行同时启用):
//  - 启用:仅把该行 active=1,作为「用途模型路由」下拉的候选,不影响其他配置;
//  - 停用:被路由使用的配置阻止停用(先在路由中改选)。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { aiProviderConfigs } from '../../../../db/schema'
import { getAiPurposeRouting } from '../../../../utils/ai'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  }
  const body = await readBody<{ enabled?: boolean }>(event).catch(() => ({}) as { enabled?: boolean })
  const enabled = body.enabled !== false

  const db = useD1(event)
  const rows = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).all()
  if (!rows[0]) {
    throw createError({ statusCode: 404, statusMessage: '配置不存在' })
  }

  // 停用前检查:被用途路由使用的配置阻止停用
  if (!enabled) {
    const routing = await getAiPurposeRouting(event)
    if (routing.worldGen === id || routing.chat === id) {
      const usedBy = [
        routing.worldGen === id ? '生成世界' : null,
        routing.chat === id ? '对话' : null
      ].filter(Boolean).join('、')
      throw createError({
        statusCode: 409,
        statusMessage: `该配置正被用途路由使用(${usedBy}),请先在「用途模型路由」中改选后再停用`
      })
    }
  }

  await db.update(aiProviderConfigs)
    .set({ active: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(aiProviderConfigs.id, id))
    .run()

  return { ok: true, enabled }
})
