// server/api/admin/recharge/list.get.ts
// 充值记录(管理端):全量 token 加油包订单 + 下单用户信息,支持状态筛选与分页,按时间倒序。
// 另返回各状态计数统计与收入统计(总收入/近30天/近24小时,均按已支付订单实付金额计,单位分)。
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { quotaPackageOrder, user as usersTable } from '../../../db/schema'
import { eq, desc, count, and, gte, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const query = getQuery<{ status?: string, page?: string, pageSize?: string }>(event)

  const status = (query.status ?? '').trim() || undefined
  const page = Math.max(1, Math.floor(Number(query.page ?? 1)) || 1)
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize ?? 20)) || 20))
  const where = status ? eq(quotaPackageOrder.status, status) : undefined

  const total = await db.select({ n: count() }).from(quotaPackageOrder).where(where).all()
  const rows = await db.select({
    id: quotaPackageOrder.id,
    orderNo: quotaPackageOrder.orderNo,
    userId: quotaPackageOrder.userId,
    userName: usersTable.name,
    userEmail: usersTable.email,
    packageId: quotaPackageOrder.packageId,
    packageName: quotaPackageOrder.packageName,
    amount: quotaPackageOrder.amount,
    currency: quotaPackageOrder.currency,
    provider: quotaPackageOrder.provider,
    providerTradeNo: quotaPackageOrder.providerTradeNo,
    status: quotaPackageOrder.status,
    paidAt: quotaPackageOrder.paidAt,
    createdAt: quotaPackageOrder.createdAt
  })
    .from(quotaPackageOrder)
    .leftJoin(usersTable, eq(usersTable.id, quotaPackageOrder.userId))
    .where(where)
    .orderBy(desc(quotaPackageOrder.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  const stats = await db.select({
    status: quotaPackageOrder.status,
    n: count()
  })
    .from(quotaPackageOrder)
    .groupBy(quotaPackageOrder.status)
    .all()

  // ---- 收入统计(已支付订单实付金额,分;退款状态无产生路径,暂不抵扣) ----
  const paid = eq(quotaPackageOrder.status, 'paid')
  // 支付时间兜底用创建时间(老数据 paidAt 可能为空)
  // 注意:paidTime 是原始 SQL 表达式,drizzle 不会自动把 Date 参数转毫秒整数,D1 也无法序列化 Date,
  // 因此时间参数必须用毫秒数字(timestamp_ms 列存储的就是毫秒整数),不能用 new Date()。
  const paidTime = sql`COALESCE(${quotaPackageOrder.paidAt}, ${quotaPackageOrder.createdAt})`
  const day24Ago = Date.now() - 24 * 60 * 60 * 1000
  const day30Ago = Date.now() - 30 * 24 * 60 * 60 * 1000
  const revTotal = await db.select({ total: sql<number>`COALESCE(SUM(${quotaPackageOrder.amount}), 0)` })
    .from(quotaPackageOrder)
    .where(paid)
    .all()
  const revDay24 = await db.select({ total: sql<number>`COALESCE(SUM(${quotaPackageOrder.amount}), 0)` })
    .from(quotaPackageOrder)
    .where(and(paid, gte(paidTime, day24Ago)))
    .all()
  const revDay30 = await db.select({ total: sql<number>`COALESCE(SUM(${quotaPackageOrder.amount}), 0)` })
    .from(quotaPackageOrder)
    .where(and(paid, gte(paidTime, day30Ago)))
    .all()

  return {
    rows: rows.map(r => ({
      id: r.id,
      orderNo: r.orderNo,
      userId: r.userId,
      userName: r.userName,
      userEmail: r.userEmail,
      packageId: r.packageId,
      packageName: r.packageName,
      /** 分 */
      amount: r.amount,
      currency: r.currency,
      provider: r.provider,
      providerTradeNo: r.providerTradeNo,
      status: r.status,
      paidAt: r.paidAt ? Number(r.paidAt) : null,
      createdAt: Number(r.createdAt)
    })),
    total: total[0]?.n ?? 0,
    page,
    pageSize,
    stats,
    /** 收入统计(分):总收入/近30天/近24小时,仅计已支付订单实付金额 */
    revenue: {
      total: revTotal[0]?.total ?? 0,
      day30: revDay30[0]?.total ?? 0,
      day24: revDay24[0]?.total ?? 0
    }
  }
})
