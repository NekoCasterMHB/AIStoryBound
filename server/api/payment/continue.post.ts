// server/api/payment/continue.post.ts
// 继续支付(登录):购买记录里对 30 分钟内未支付的 pending 订单重新生成网关支付参数,
// 沿用原 out_trade_no(网关幂等键,同一笔订单继续付款),前端动态 form POST 跳转收银台。
import { requireUser } from '../../utils/authz'
import { getMicropayConfig, buildSignStr, signRSA } from '../../utils/micropay'
import { useD1 } from '../../utils/d1'
import { PENDING_ORDER_TTL_MS } from '../../utils/orders'
import { quotaPackageOrder } from '../../db/schema'
import { eq, and } from 'drizzle-orm'

/** 网关提交地址(与 payment/create 一致) */
const GATEWAY_SUBMIT_URL = 'https://pay.microgg.cn/api/pay/submit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ orderNo?: string }>(event).catch(() => ({} as { orderNo?: string }))
  const { orderNo } = body
  if (!orderNo) throw createError({ statusCode: 400, statusMessage: '缺少 orderNo' })

  const db = useD1(event)
  const order = await db.select().from(quotaPackageOrder)
    .where(and(eq(quotaPackageOrder.orderNo, orderNo), eq(quotaPackageOrder.userId, user.id)))
    .get()
  if (!order) throw createError({ statusCode: 404, statusMessage: '订单不存在' })

  // 已支付/已关闭/已退款:不可继续支付
  if (order.status !== 'pending') {
    throw createError({ statusCode: 400, statusMessage: order.status === 'paid' ? '该订单已支付' : '该订单已关闭,请重新下单' })
  }
  // 超时未支付:置为 closed 并拒绝
  if (Date.now() - Number(order.createdAt) > PENDING_ORDER_TTL_MS) {
    await db.update(quotaPackageOrder)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(eq(quotaPackageOrder.id, order.id))
      .run()
    throw createError({ statusCode: 400, statusMessage: '订单已超时关闭,请重新下单' })
  }

  const cfg = getMicropayConfig(event)
  if (!cfg.pid || !cfg.privateKey) {
    throw createError({ statusCode: 500, statusMessage: '支付未配置(缺少 MICROPAY_PID / MICROPAY_PRIVATE_KEY)' })
  }

  const baseUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`
  const params: Record<string, string | number> = {
    pid: cfg.pid,
    type: order.provider,
    out_trade_no: order.orderNo, // 沿用原订单号,网关幂等,继续原订单付款
    notify_url: `${baseUrl}/api/payment/notify`,
    return_url: `${baseUrl}/profile`,
    name: order.packageName,
    money: (Number(order.amount) / 100).toFixed(2),
    timestamp: Math.floor(Date.now() / 1000),
    param: JSON.stringify({ userId: order.userId, packageId: order.packageId }),
    sign_type: 'RSA'
  }
  params.sign = await signRSA(buildSignStr(params), cfg.privateKey)

  return { action: GATEWAY_SUBMIT_URL, params }
})
