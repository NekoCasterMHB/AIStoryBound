// 管理员动态切换启用配置:目标行 active=1,其余全部置 0(事务内完成,即时生效)。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { aiProviderConfigs } from '../../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  }

  const db = useD1(event)
  const rows = await db.select({ id: aiProviderConfigs.id }).from(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).all()
  if (!rows[0]) {
    throw createError({ statusCode: 404, statusMessage: '配置不存在' })
  }

  // D1 不支持 BEGIN 事务语句,用 batch(单次原子执行)完成「全量置 0 + 目标置 1」
  await db.batch([
    db.update(aiProviderConfigs).set({ active: 0 }),
    db.update(aiProviderConfigs).set({ active: 1, updatedAt: new Date() })
      .where(eq(aiProviderConfigs.id, id))
  ])

  return { ok: true }
})
