// server/api/admin/recharge/list.get.ts
// 充值记录(管理端):全量 token 加油包订单 + 下单用户信息,支持状态筛选与分页,按时间倒序。
// 另返回各状态计数统计,供管理页展示概览。
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { quotaPackageOrder, user as usersTable } from '../../../db/schema'
import { eq, desc, count } from 'drizzle-orm'

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
    stats
  }
})