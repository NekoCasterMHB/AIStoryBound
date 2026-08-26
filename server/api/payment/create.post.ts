// server/api/payment/create.post.ts
// 创建 token 加油包订单(微支付网关):鉴权 → 商品白名单 → 服务端定价 → 商户私钥签名 →
// 建 pending 订单 → 返回 { action, params }(前端动态 form POST 跳转网关收银台)。
import { requireUser } from '../../utils/authz'
import { getMicropayConfig, buildSignStr, signRSA, generateOutTradeNo } from '../../utils/micropay'
import { isTokenPackageId, getTokenPackageById } from '../../../shared/quota-packages'
import { useD1 } from '../../utils/d1'
import { isPaymentDisabled } from '../../utils/config'
import { quotaPackageOrder } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { uuid } from '../../../shared/novel'

/** 网关提交地址(参考 docs/payment-integration.md) */
const GATEWAY_SUBMIT_URL = 'https://pay.microgg.cn/api/pay/submit'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)

  // 充值开关(管理端可即时启停,见 /admin/recharge 与 app_config 表)
  if (await isPaymentDisabled(db)) {
    throw createError({ statusCode: 503, statusMessage: '充值功能维护中,暂时无法下单' })
  }

  const body = await readBody<{ packageId?: string, payType?: string }>(event).catch(() => ({} as { packageId?: string, payType?: string }))
  const { packageId, payType } = body

  if (!packageId || !isTokenPackageId(packageId)) {
    throw createError({ statusCode: 400, statusMessage: '无效的商品' })
  }
  if (payType !== 'wxpay' && payType !== 'alipay') {
    throw createError({ statusCode: 400, statusMessage: 'payType 必须为 wxpay 或 alipay' })
  }
  const pkg = getTokenPackageById(packageId)!

  const cfg = getMicropayConfig(event)
  if (!cfg.pid || !cfg.privateKey) {
    throw createError({ statusCode: 500, statusMessage: '支付未配置(缺少 MICROPAY_PID / MICROPAY_PRIVATE_KEY)' })
  }

  const outTradeNo = generateOutTradeNo()
  const baseUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`

  const params: Record<string, string | number> = {
    pid: cfg.pid,
    type: payType,
    out_trade_no: outTradeNo,
    notify_url: `${baseUrl}/api/payment/notify`,
    return_url: `${baseUrl}/profile`,
    name: pkg.label,
    money: pkg.priceYuan.toFixed(2),
    timestamp: Math.floor(Date.now() / 1000),
    // 业务上下文走签名参数(回调解析 userId/packageId,前端不可改)
    param: JSON.stringify({ userId: sessUser.id, packageId }),
    sign_type: 'RSA'
  }
  params.sign = await signRSA(buildSignStr(params), cfg.privateKey)

  // 建 pending 订单(购买记录可查;回调据此幂等入账)
  const now = new Date()

  // 限购套餐:每人仅可购买一次(按已支付订单判定;待支付/已退款不拦截)
  if (pkg.oneTimeOnly) {
    const owned = await db.select().from(quotaPackageOrder)
      .where(and(
        eq(quotaPackageOrder.userId, sessUser.id),
        eq(quotaPackageOrder.packageId, packageId),
        eq(quotaPackageOrder.status, 'paid')
      ))
      .get()
    if (owned) throw createError({ statusCode: 400, statusMessage: '该套餐每人限购一次' })
  }

  await db.insert(quotaPackageOrder).values({
    id: uuid(),
    orderNo: outTradeNo,
    userId: sessUser.id,
    packageId,
    packageName: pkg.label,
    amount: Math.round(pkg.priceYuan * 100),
    currency: 'CNY',
    provider: payType,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  }).run()

  return { action: GATEWAY_SUBMIT_URL, params }
})
