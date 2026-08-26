// server/api/payment/result.get.ts
// 支付结果确认(登录):网关支付完成跳回 return_url(/profile)时,前端带 orderNo 查询订单真实状态。
// 以数据库为准(只有验签通过的回调才会写库),避免信任 URL 上的回调参数。
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { quotaPackageOrder } from '../../db/schema'
import { eq, and } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { orderNo } = getQuery<{ orderNo?: string }>(event)
  if (!orderNo) throw createError({ statusCode: 400, statusMessage: '缺少 orderNo' })

  const db = useD1(event)
  const row = await db.select({
    id: quotaPackageOrder.id,
    orderNo: quotaPackageOrder.orderNo,
    packageId: quotaPackageOrder.packageId,
    packageName: quotaPackageOrder.packageName,
    amount: quotaPackageOrder.amount,
    provider: quotaPackageOrder.provider,
    providerTradeNo: quotaPackageOrder.providerTradeNo,
    status: quotaPackageOrder.status,
    paidAt: quotaPackageOrder.paidAt,
    createdAt: quotaPackageOrder.createdAt
  })
    .from(quotaPackageOrder)
    .where(and(eq(quotaPackageOrder.orderNo, orderNo), eq(quotaPackageOrder.userId, user.id)))
    .get()

  if (!row) throw createError({ statusCode: 404, statusMessage: '订单不存在' })
  return {
    orderNo: row.orderNo,
    packageId: row.packageId,
    packageName: row.packageName,
    amount: row.amount,
    provider: row.provider,
    providerTradeNo: row.providerTradeNo,
    status: row.status,
    paidAt: row.paidAt ? Number(row.paidAt) : null,
    createdAt: Number(row.createdAt)
  }
})
