// server/api/admin/redeem/list.get.ts
// 管理员查看全部兑换码(用量/状态/过期时间),按创建时间倒序
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { redeemCodes } from '../../../db/schema'
import { desc } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const rows = await db.select().from(redeemCodes).orderBy(desc(redeemCodes.createdAt)).all()
  return rows.map(r => ({
    id: r.id,
    code: r.code,
    tokens: r.tokens,
    usedCount: r.usedCount,
    maxUses: r.maxUses,
    perUserLimit: r.perUserLimit,
    disabled: r.disabled,
    expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
    createdAt: r.createdAt.getTime()
  }))
})
