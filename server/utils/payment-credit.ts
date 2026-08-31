// server/utils/payment-credit.ts
// 支付入账公共逻辑(异步回调 notify 与主动查询 result 共用):
// order_no 幂等 → 订单置 paid → 用户 ai_token_balance 叠加。
// 返回 'success' 表示应确认收到(含已入账的重复回调),'fail' 表示拒绝入账。
import type { H3Event } from 'h3'
import { useD1 } from './d1'
import { getTokenPackageById } from '../../shared/quota-packages'
import { quotaPackageOrder, user as usersTable } from '../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { uuid } from '../../shared/novel'

/** 解码常见 HTML 实体(网关对 param 等字段可能做实体编码) */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export interface CreditPaidOrderArgs {
  /** 商户订单号(幂等键) */
  outTradeNo: string
  /** 平台流水号,可空 */
  providerTradeNo: string | null
  /** 金额(分,整数) */
  amountFen: number
  userId: string
  packageId: string
}

export async function creditPaidOrder(event: H3Event, args: CreditPaidOrderArgs): Promise<'success' | 'fail'> {
  const db = useD1(event)
  const pkg = getTokenPackageById(args.packageId)
  if (!pkg) return 'fail'
  const now = new Date()

  // 幂等:order_no 唯一约束兜底;已 paid 直接确认
  const rows = await db.select().from(quotaPackageOrder).where(eq(quotaPackageOrder.orderNo, args.outTradeNo)).all()
  const existing = rows[0]
  if (existing) {
    if (existing.status === 'paid') return 'success'
    if (existing.amount !== args.amountFen) return 'fail' // 金额不符,拒绝入账
    await db.update(quotaPackageOrder)
      .set({ status: 'paid', providerTradeNo: args.providerTradeNo ?? null, paidAt: now, updatedAt: now })
      .where(eq(quotaPackageOrder.orderNo, args.outTradeNo))
      .run()
  } else {
    await db.insert(quotaPackageOrder).values({
      id: uuid(),
      orderNo: args.outTradeNo,
      userId: args.userId,
      packageId: args.packageId,
      packageName: pkg.label,
      amount: args.amountFen,
      currency: 'CNY',
      provider: 'unknown',
      providerTradeNo: args.providerTradeNo ?? null,
      status: 'paid',
      paidAt: now,
      createdAt: now,
      updatedAt: now
    }).run()
  }

  // 配额入账(只对已存在用户生效)
  const userUpdate = await db.update(usersTable)
    .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${pkg.tokens}` })
    .where(and(eq(usersTable.id, args.userId)))
    .run()
  if (userUpdate.meta.changes === 0) return 'fail'

  return 'success'
}
