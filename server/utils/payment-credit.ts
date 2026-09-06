// server/utils/payment-credit.ts
// 支付入账公共逻辑(异步回调 notify 与主动查询 result 共用):
// order_no 幂等 → 订单置 paid → 用户 ai_token_balance 叠加 →(若有邀请人)插入邀请返利 earnings(pending)。
// 全部写操作收敛到单个 db.batch:订单置 paid 用条件更新(status != 'paid'),changes=0 即已入账,
// 并发回调(网关回调 + 跳回兜底同时到达)只会成功一次,修复了旧"先读后判"的重复入账窗口。
// 返回 'success' 表示应确认收到(含已入账的重复回调),'fail' 表示拒绝入账。
import type { H3Event } from 'h3'
import { useD1 } from './d1'
import { getTokenPackageById } from '../../shared/quota-packages'
import { INVITE_REBATE_RATIO } from '../../shared/invite'
import { quotaPackageOrder, user as usersTable, inviteRelations, earnings } from '../db/schema'
import { eq, and, ne, sql } from 'drizzle-orm'
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

  // 幂等预检(并发安全由下方条件更新兜底):已 paid 直接确认;金额不符拒绝入账
  const rows = await db.select().from(quotaPackageOrder).where(eq(quotaPackageOrder.orderNo, args.outTradeNo)).all()
  const existing = rows[0]
  if (existing && existing.status === 'paid') return 'success'
  if (existing && existing.amount !== args.amountFen) return 'fail'

  // 邀请返利:买家有邀请人且返利额 > 0 时,同一事务给邀请人插一条待领取收益(按实到 token 计,双倍包天然翻倍)
  const relRows = await db.select({ inviterId: inviteRelations.inviterId })
    .from(inviteRelations)
    .where(eq(inviteRelations.inviteeId, args.userId))
    .all()
  const inviterId = relRows[0]?.inviterId
  const rebate = inviterId ? Math.floor(pkg.tokens * INVITE_REBATE_RATIO) : 0

  // 单批原子:订单置 paid(条件更新,0 行 = 已被并发入账)→ 买家余额 → 邀请返利。
  // 订单已存在/不存在两条字面量 batch 路径,避免混合 update/insert 构造器的联合类型问题
  const rebateStmt = inviterId && rebate > 0
    ? [db.insert(earnings).values({
        id: uuid(),
        userId: inviterId,
        amount: rebate,
        sourceType: 'invite_rebate',
        sourceId: existing?.id ?? null,
        itemTitle: `邀请返利:${pkg.label}`,
        reason: null,
        status: 'pending',
        createdAt: now,
        claimedAt: null
      })]
    : []
  const userStmt = db.update(usersTable)
    .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${pkg.tokens}` })
    .where(eq(usersTable.id, args.userId))

  const results = existing
    ? await db.batch([
        db.update(quotaPackageOrder)
          .set({ status: 'paid', providerTradeNo: args.providerTradeNo ?? null, paidAt: now, updatedAt: now })
          .where(and(eq(quotaPackageOrder.orderNo, args.outTradeNo), ne(quotaPackageOrder.status, 'paid'))),
        userStmt,
        ...rebateStmt
      ])
    : await db.batch([
        db.insert(quotaPackageOrder).values({
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
        }),
        userStmt,
        ...rebateStmt
      ])

  // 语句 0 changes=0:并发回调已把订单置 paid(余额/返利不会再走)——视为已入账成功
  const claimChanges = (results[0] as { meta: { changes: number } }).meta.changes
  if (claimChanges === 0) return 'success'
  // 语句 1 changes=0:用户不存在,订单已被置 paid(边缘态,与旧行为一致)
  const userChanges = (results[1] as { meta: { changes: number } }).meta.changes
  if (userChanges === 0) return 'fail'

  return 'success'
}
