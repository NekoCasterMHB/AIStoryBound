// server/api/profile/purchases.get.ts
// 购买历史(登录用户,按时间倒序)
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { eq, desc } from 'drizzle-orm'
import { quotaPackageOrder } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  const rows = await db.select().from(quotaPackageOrder)
    .where(eq(quotaPackageOrder.userId, sessUser.id))
    .orderBy(desc(quotaPackageOrder.createdAt))
    .all()
  return rows.map(r => ({
    id: r.id,
    orderNo: r.orderNo,
    packageId: r.packageId,
    packageName: r.packageName,
    /** 分 */
    amount: r.amount,
    currency: r.currency,
    provider: r.provider,
    providerTradeNo: r.providerTradeNo,
    status: r.status,
    paidAt: r.paidAt,
    createdAt: r.createdAt
  }))
})
