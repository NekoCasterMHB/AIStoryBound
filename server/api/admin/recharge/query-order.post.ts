// server/api/admin/recharge/query-order.post.ts
// 查询到账(管理端):对未支付/已关闭等非 paid 订单主动查网关,网关确认已支付(code:0 且平台公钥验签通过,
// status:1)则复用回调同一套幂等入账(标记 paid + 发放 token),用于回调丢失/网关密钥轮换期间的补到账。
import { requireAdmin } from '../../../utils/authz'
import { useD1 } from '../../../utils/d1'
import { queryGatewayOrder } from '../../../utils/micropay'
import { creditPaidOrder } from '../../../utils/payment-credit'
import { quotaPackageOrder } from '../../../db/schema'
import { eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody<{ orderNo?: string }>(event).catch(() => ({} as { orderNo?: string }))
  const orderNo = (body?.orderNo ?? '').trim()
  if (!orderNo) throw createError({ statusCode: 400, statusMessage: '缺少 orderNo' })

  const db = useD1(event)
  const order = await db.select({
    orderNo: quotaPackageOrder.orderNo,
    userId: quotaPackageOrder.userId,
    packageId: quotaPackageOrder.packageId,
    amount: quotaPackageOrder.amount,
    providerTradeNo: quotaPackageOrder.providerTradeNo,
    status: quotaPackageOrder.status
  })
    .from(quotaPackageOrder)
    .where(eq(quotaPackageOrder.orderNo, orderNo))
    .get()
  if (!order) throw createError({ statusCode: 404, statusMessage: '订单不存在' })

  // 已支付无需再查
  if (order.status === 'paid') {
    return { status: 'paid', credited: false, message: '该订单已支付,无需重复查询' }
  }

  // 主动查网关(请求用商户私钥签名,响应用平台公钥验签;失败返回 null)
  const info = await queryGatewayOrder(event, orderNo)
  if (!info) {
    return { status: order.status, credited: false, message: '网关查询失败或响应验签未通过,请稍后重试或核对网关侧订单' }
  }
  if (info.status !== 1) {
    return { status: order.status, credited: false, message: '网关侧订单未支付,尚未到账' }
  }

  // 网关确认已支付 → 幂等入账(金额/商品以本地订单为准)
  const result = await creditPaidOrder(event, {
    outTradeNo: orderNo,
    providerTradeNo: info.tradeNo || order.providerTradeNo,
    amountFen: order.amount,
    userId: order.userId,
    packageId: order.packageId
  })
  if (result !== 'success') {
    return { status: order.status, credited: false, message: '网关确认已支付,但本地入账失败(金额不符或用户不存在),请人工核查' }
  }

  return { status: 'paid', credited: true, message: '已确认到账并发放 token' }
})
