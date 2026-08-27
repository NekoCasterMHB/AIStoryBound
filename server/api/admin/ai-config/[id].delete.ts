// 管理员删除平台 AI 配置;若删的是当前启用配置,自动激活剩余最早创建的一条(没有则回退环境变量)。
import { asc, eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { aiProviderConfigs } from '../../../db/schema'

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
  const wasActive = row.active === 1

  await db.delete(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).run()

  if (wasActive) {
    const rest = await db.select().from(aiProviderConfigs).orderBy(asc(aiProviderConfigs.createdAt)).all()
    if (rest[0]) {
      await db.update(aiProviderConfigs).set({ active: 1 }).where(eq(aiProviderConfigs.id, rest[0].id)).run()
    }
  }

  return { ok: true }
})
