// server/utils/orders.ts
// 订单生命周期工具:待支付订单超时自动关闭(惰性:由请求路径触发,见 create.post.ts 限购检查)。
// 网关侧订单超时未支付同样失效;超时后被支付的订单,回调仍会将其置为 paid(用户付了钱必须入账)。
import type { H3Event } from 'h3'
import { useD1 } from './d1'
import { quotaPackageOrder } from '../db/schema'
import { eq, and, lt, inArray } from 'drizzle-orm'

/** 待支付订单超过该时长自动关闭(30 分钟) */
export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000

/** 关闭所有超时未支付的 pending 订单(幂等,可重复调用),返回本次关闭数量 */
export async function closeExpiredPendingOrders(event: H3Event): Promise<number> {
  const db = useD1(event)
  const expired = await db.select({ id: quotaPackageOrder.id })
    .from(quotaPackageOrder)
    .where(and(
      eq(quotaPackageOrder.status, 'pending'),
      lt(quotaPackageOrder.createdAt, new Date(Date.now() - PENDING_ORDER_TTL_MS))
    ))
    .all()
  if (!expired.length) return 0
  const ids = expired.map(r => r.id)
  await db.update(quotaPackageOrder)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(inArray(quotaPackageOrder.id, ids))
    .run()
  return ids.length
}
