// server/api/admin/redeem/[id].get.ts
// 管理员查看单个兑换码详情 + 兑换明细(谁在什么时候领了多少)
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { redeemCodes, redeemCodeRedemptions, user as usersTable } from '../../../db/schema'
import { asc, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  }

  const db = useD1(event)
  const rows = await db.select().from(redeemCodes).where(eq(redeemCodes.id, id)).all()
  const rc = rows[0]
  if (!rc) {
    throw createError({ statusCode: 404, statusMessage: '兑换码不存在' })
  }

  const redemptions = await db.select({
    id: redeemCodeRedemptions.id,
    tokens: redeemCodeRedemptions.tokens,
    createdAt: redeemCodeRedemptions.createdAt,
    userEmail: usersTable.email,
    userName: usersTable.name
  })
    .from(redeemCodeRedemptions)
    .leftJoin(usersTable, eq(redeemCodeRedemptions.userId, usersTable.id))
    .where(eq(redeemCodeRedemptions.codeId, id))
    .orderBy(asc(redeemCodeRedemptions.createdAt))
    .all()

  return {
    id: rc.id,
    code: rc.code,
    tokens: rc.tokens,
    usedCount: rc.usedCount,
    maxUses: rc.maxUses,
    perUserLimit: rc.perUserLimit,
    disabled: rc.disabled,
    expiresAt: rc.expiresAt ? rc.expiresAt.getTime() : null,
    createdAt: rc.createdAt.getTime(),
    redemptions: redemptions.map(r => ({
      id: r.id,
      tokens: r.tokens,
      createdAt: r.createdAt.getTime(),
      userEmail: r.userEmail,
      userName: r.userName
    }))
  }
})