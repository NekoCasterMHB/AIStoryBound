// server/api/admin/recharge/test-create.post.ts
// 充值测试(管理端):管理员创建一笔 0.1 元测试订单,走与真实充值完全一致的
// 网关签名 → pending 建单 → 回调入账链路,用于验证支付回调是否正常到账。
// 测试套餐 tokens=0,回调只把订单置为 paid,不发放配额(见 shared/quota-packages.ts TEST_PACKAGE)。
import { requireAdmin } from '../../../utils/authz'
import { getMicropayConfig, buildSignStr, signRSA, generateOutTradeNo } from '../../../utils/micropay'
import { TEST_PACKAGE } from '../../../../shared/quota-packages'
import { useD1 } from '../../../utils/d1'
import { isPaymentDisabled } from '../../../utils/config'
import { quotaPackageOrder } from '../../../db/schema'
import { uuid } from '../../../../shared/novel'

/** 网关提交地址(与 payment/create 一致) */
const GATEWAY_SUBMIT_URL = 'https://pay.microgg.cn/api/pay/submit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const db = useD1(event)

  // 充值开关:关闭时管理端测试下单也一并禁止(避免测试单无人处理)
  if (await isPaymentDisabled(db)) {
    throw createError({ statusCode: 503, statusMessage: '充值功能维护中,暂时无法下单' })
  }

  const body = await readBody<{ payType?: string }>(event).catch(() => ({} as { payType?: string }))
  const { payType } = body
  if (payType !== 'wxpay' && payType !== 'alipay') {
    throw createError({ statusCode: 400, statusMessage: 'payType 必须为 wxpay 或 alipay' })
  }

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
    name: TEST_PACKAGE.label,
    money: TEST_PACKAGE.priceYuan.toFixed(2),
    timestamp: Math.floor(Date.now() / 1000),
    // 业务上下文:userId 用管理员本人,方便在充值记录里直接看到测试订单
    param: JSON.stringify({ userId: admin.id, packageId: TEST_PACKAGE.id }),
    sign_type: 'RSA'
  }
  params.sign = await signRSA(buildSignStr(params), cfg.privateKey)

  const now = new Date()
  await db.insert(quotaPackageOrder).values({
    id: uuid(),
    orderNo: outTradeNo,
    userId: admin.id,
    packageId: TEST_PACKAGE.id,
    packageName: TEST_PACKAGE.label,
    amount: Math.round(TEST_PACKAGE.priceYuan * 100),
    currency: 'CNY',
    provider: payType,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  }).run()

  return { action: GATEWAY_SUBMIT_URL, params }
})
