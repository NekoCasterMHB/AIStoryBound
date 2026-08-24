// server/api/admin/redeem/[id]/disable.post.ts
// 管理员停用/恢复兑换码(翻转 disabled,保留已产生的兑换记录)
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { redeemCodes } from '../../../../db/schema'
import { eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<{ disabled?: boolean }>(event).catch(() => null)
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  }

  const db = useD1(event)
  const res = await db.update(redeemCodes)
    .set({ disabled: body?.disabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(redeemCodes.id, id))
    .run()
  if (res.meta.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: '兑换码不存在' })
  }
  return { ok: true }
})