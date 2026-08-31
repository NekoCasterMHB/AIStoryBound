// server/utils/payment-notify.ts
// 微支付网关异步回调处理(POST/GET 共用,网关可能以任意一种方式回调):
// 平台公钥验签 → 时间戳新鲜度校验 → 仅处理 TRADE_SUCCESS → 幂等入账(creditPaidOrder,与主动查询共用)
// → 返回文本 success/fail(网关按内容重试)。
import type { H3Event } from 'h3'
import { getMicropayConfig, buildSignStr, verifyRSA, isTimestampFresh } from './micropay'
import { decodeHtmlEntities, creditPaidOrder } from './payment-credit'

export async function handlePaymentNotify(event: H3Event): Promise<string> {
  const query = getQuery(event)
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}))
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...query, ...body })) {
    if (typeof v === 'string' || typeof v === 'number') params[k] = String(v)
  }

  const cfg = getMicropayConfig(event)
  if (!cfg.publicKey) return 'fail'

  // 1) 验签(参数签名异常直接 fail,网关会重试)
  const ok = await verifyRSA(buildSignStr(params), params.sign ?? '', cfg.publicKey)
  if (!ok) return 'fail'

  // 2) 时间戳新鲜度(±300s,与官方 SDK verify() 一致,防重放;过期回调网关会以新时间戳重试)
  if (!isTimestampFresh(params.timestamp)) return 'fail'

  // 3) 只处理成功状态;其余状态确认收到即可,不入账
  if (params.trade_status !== 'TRADE_SUCCESS') return 'success'

  // 4) 关键字段:网关返回/回调的 param 可能为 HTML 实体编码({&quot;userId&quot;...}),先解码再解析
  const outTradeNo = params.out_trade_no
  const amountFen = Math.round(parseFloat(params.money ?? '') * 100)
  let biz: { userId?: string, packageId?: string }
  try {
    biz = JSON.parse(decodeHtmlEntities(params.param ?? '{}'))
  } catch {
    return 'fail'
  }
  if (!outTradeNo || !biz.userId || !biz.packageId) return 'fail'

  // 5) 幂等入账(notify 与主动查询共用同一逻辑)
  return await creditPaidOrder(event, {
    outTradeNo,
    providerTradeNo: params.trade_no ?? null,
    amountFen,
    userId: biz.userId,
    packageId: biz.packageId
  })
}
