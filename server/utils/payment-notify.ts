// server/utils/payment-notify.ts
// 微支付网关异步回调处理(POST/GET 共用,网关可能以任意一种方式回调):
// 平台公钥验签 → 仅处理 TRADE_SUCCESS → order_no 幂等入账(订单 paid + 用户 ai_token_balance 叠加)
// → 返回文本 success/fail(网关按内容重试)。
import type { H3Event } from 'h3'
import { getMicropayConfig, buildSignStr, verifyRSA } from './micropay'
import { getTokenPackageById } from '../../shared/quota-packages'
import { useD1 } from './d1'
import { quotaPackageOrder, user as usersTable } from '../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { uuid } from '../../shared/novel'

/** 解码常见 HTML 实体(网关对 param 等字段可能做实体编码) */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

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

  // 2) 只处理成功状态;其余状态确认收到即可,不入账
  if (params.trade_status !== 'TRADE_SUCCESS') return 'success'

  // 3) 关键字段
  const outTradeNo = params.out_trade_no
  const amountFen = Math.round(parseFloat(params.money ?? '') * 100)
  // 网关返回/回调的 param 可能为 HTML 实体编码({&quot;userId&quot;...}),先解码再解析
  let biz: { userId?: string, packageId?: string }
  try {
    biz = JSON.parse(decodeHtmlEntities(params.param ?? '{}'))
  } catch {
    return 'fail'
  }
  if (!outTradeNo || !biz.userId || !biz.packageId) return 'fail'

  const pkg = getTokenPackageById(biz.packageId)
  if (!pkg) return 'fail'

  const db = useD1(event)
  const now = new Date()

  // 4) 幂等:order_no 唯一约束兜底;已 paid 直接确认
  const rows = await db.select().from(quotaPackageOrder).where(eq(quotaPackageOrder.orderNo, outTradeNo)).all()
  const existing = rows[0]
  if (existing) {
    if (existing.status === 'paid') return 'success'
    if (existing.amount !== amountFen) return 'fail' // 金额不符,拒绝入账
    await db.update(quotaPackageOrder)
      .set({ status: 'paid', providerTradeNo: params.trade_no ?? null, paidAt: now, updatedAt: now })
      .where(eq(quotaPackageOrder.orderNo, outTradeNo))
      .run()
  } else {
    await db.insert(quotaPackageOrder).values({
      id: uuid(),
      orderNo: outTradeNo,
      userId: biz.userId,
      packageId: biz.packageId,
      packageName: pkg.label,
      amount: amountFen,
      currency: 'CNY',
      provider: 'unknown',
      providerTradeNo: params.trade_no ?? null,
      status: 'paid',
      paidAt: now,
      createdAt: now,
      updatedAt: now
    }).run()
  }

  // 5) 配额入账(只对已存在用户生效)
  const userUpdate = await db.update(usersTable)
    .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${pkg.tokens}` })
    .where(and(eq(usersTable.id, biz.userId)))
    .run()
  if (userUpdate.meta.changes === 0) return 'fail'

  return 'success'
}
