// server/api/payment/result.get.ts
// 支付结果确认(登录):网关支付完成跳回 return_url(/profile)时,前端带 orderNo 查询订单真实状态。
// 以数据库为准(只有验签通过的回调才会写库,避免信任 URL 上的回调参数);
// 订单 pending 时主动查询网关兜底(异步回调可能延迟/丢失),网关确认已支付则复用
// 回调同一套幂等入账逻辑后返回最新状态。
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { queryGatewayOrder } from '../../utils/micropay'
import { creditPaidOrder } from '../../utils/payment-credit'
import { quotaPackageOrder } from '../../db/schema'
import { eq, and } from 'drizzle-orm'

/** 主动查询网关冷却:同一订单短时间内只查一次,避免前端轮询(5s/次)打爆网关查询接口(进程内,不跨 isolate) */
const gatewayQueryCooldown = new Map<string, number>()
const GATEWAY_QUERY_COOLDOWN_MS = 30_000

function sweepGatewayCooldown(now: number) {
  if (gatewayQueryCooldown.size <= 1000) return
  for (const [k, v] of gatewayQueryCooldown) {
    if (v + GATEWAY_QUERY_COOLDOWN_MS <= now) gatewayQueryCooldown.delete(k)
  }
}

interface OrderRowShape {
  id: string
  orderNo: string
  userId: string
  packageId: string
  packageName: string
  amount: number
  provider: string
  providerTradeNo: string | null
  status: string
  paidAt: Date | null
  createdAt: Date
}

const orderFields = {
  id: quotaPackageOrder.id,
  orderNo: quotaPackageOrder.orderNo,
  userId: quotaPackageOrder.userId,
  packageId: quotaPackageOrder.packageId,
  packageName: quotaPackageOrder.packageName,
  amount: quotaPackageOrder.amount,
  provider: quotaPackageOrder.provider,
  providerTradeNo: quotaPackageOrder.providerTradeNo,
  status: quotaPackageOrder.status,
  paidAt: quotaPackageOrder.paidAt,
  createdAt: quotaPackageOrder.createdAt
}

function serializeOrder(row: OrderRowShape) {
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
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { orderNo } = getQuery<{ orderNo?: string }>(event)
  if (!orderNo) throw createError({ statusCode: 400, statusMessage: '缺少 orderNo' })

  const db = useD1(event)
  const row = await db.select(orderFields)
    .from(quotaPackageOrder)
    .where(and(eq(quotaPackageOrder.orderNo, orderNo), eq(quotaPackageOrder.userId, user.id)))
    .get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '订单不存在' })

  // pending/closed 时主动查询网关兜底(冷却期内直接返回当前状态;历史卡单同样可自愈,
  // 网关确认已支付即入账——用户付了钱必须到账,closed 是惰性标记不代表用户没付)
  const nowMs = Date.now()
  if (
    (row.status === 'pending' || row.status === 'closed')
    && (gatewayQueryCooldown.get(orderNo) ?? 0) + GATEWAY_QUERY_COOLDOWN_MS <= nowMs
  ) {
    gatewayQueryCooldown.set(orderNo, nowMs)
    sweepGatewayCooldown(nowMs)

    const info = await queryGatewayOrder(event, orderNo)
    if (info && info.status === 1) {
      // 金额/商品以本地订单为准(服务端定价权威),网关回包仅作支付确认
      const result = await creditPaidOrder(event, {
        outTradeNo: orderNo,
        providerTradeNo: info.tradeNo || null,
        amountFen: row.amount,
        userId: row.userId,
        packageId: row.packageId
      })
      if (result === 'success') {
        const fresh = await db.select(orderFields).from(quotaPackageOrder)
          .where(eq(quotaPackageOrder.orderNo, orderNo))
          .get()
        if (fresh) return serializeOrder(fresh)
      }
    }
  }

  return serializeOrder(row)
})
