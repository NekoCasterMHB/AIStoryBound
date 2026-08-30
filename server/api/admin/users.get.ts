// server/api/admin/users.get.ts
// 用户管理(管理端):全量注册用户列表,展示 token 余额(aiTokenBalance)、累计消费 token
// (ai_usage 表逐条扣费记录求和)与累计充值金额(quota_package_order 已支付订单实付合计,分),
// 支持按余额/消费量/充值金额/注册时间排序(升/降序)与分页。
import { useD1 } from '../../utils/d1'
import { requireAdmin } from '../../utils/authz'
import { user as usersTable, aiUsage, quotaPackageOrder } from '../../db/schema'
import { eq, desc, asc, count, sql, and, like, or } from 'drizzle-orm'

const SORT_FIELDS = ['balance', 'consumed', 'recharged', 'createdAt'] as const
type SortField = typeof SORT_FIELDS[number]

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const query = getQuery<{ page?: string, pageSize?: string, sort?: string, dir?: string, q?: string }>(event)

  const page = Math.max(1, Math.floor(Number(query.page ?? 1)) || 1)
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize ?? 20)) || 20))
  // 排序白名单:balance=token 余额 | consumed=累计消费 | createdAt=注册时间
  const sort: SortField = (SORT_FIELDS as readonly string[]).includes(query.sort ?? '')
    ? query.sort as SortField
    : 'createdAt'
  const dir = query.dir === 'asc' ? 'asc' : 'desc'
  // 搜索:按昵称/邮箱/用户 ID 模糊匹配(去掉 LIKE 通配符防注入干扰;D1 LIKE 对 ASCII 不区分大小写)
  const q = String(query.q ?? '').trim().slice(0, 100).replace(/[%_\\]/g, '')
  const searchWhere = q
    ? or(
        like(usersTable.name, `%${q}%`),
        like(usersTable.email, `%${q}%`),
        like(usersTable.id, `%${q}%`)
      )
    : undefined

  // 每用户累计消费(子查询;未消费用户 COALESCE 为 0,排序不受 NULL 干扰)
  const usage = db.select({
    userId: aiUsage.userId,
    consumed: sql<number>`COALESCE(SUM(${aiUsage.tokens}), 0)`.as('consumed')
  })
    .from(aiUsage)
    .groupBy(aiUsage.userId)
    .as('usage')

  // 每用户累计充值金额(已支付订单实付合计,单位分;未充值用户 COALESCE 为 0)
  const recharge = db.select({
    userId: quotaPackageOrder.userId,
    recharged: sql<number>`COALESCE(SUM(${quotaPackageOrder.amount}), 0)`.as('recharged')
  })
    .from(quotaPackageOrder)
    .where(eq(quotaPackageOrder.status, 'paid'))
    .groupBy(quotaPackageOrder.userId)
    .as('recharge')

  const orderBy = dir === 'asc'
    ? asc(sort === 'balance' ? usersTable.aiTokenBalance : sort === 'consumed' ? usage.consumed : sort === 'recharged' ? recharge.recharged : usersTable.createdAt)
    : desc(sort === 'balance' ? usersTable.aiTokenBalance : sort === 'consumed' ? usage.consumed : sort === 'recharged' ? recharge.recharged : usersTable.createdAt)

  // 搜索时 total 为过滤后总数(汇总统计卡片仍为全站数据)
  const total = searchWhere
    ? await db.select({ n: count() }).from(usersTable).where(searchWhere).all()
    : await db.select({ n: count() }).from(usersTable).all()
  const rows = await db.select({
    id: usersTable.id,
    name: usersTable.name,
    email: usersTable.email,
    emailVerified: usersTable.emailVerified,
    aiTokenBalance: usersTable.aiTokenBalance,
    consumed: usage.consumed,
    recharged: recharge.recharged,
    createdAt: usersTable.createdAt
  })
    .from(usersTable)
    .leftJoin(usage, eq(usage.userId, usersTable.id))
    .leftJoin(recharge, eq(recharge.userId, usersTable.id))
    .where(searchWhere ? and(searchWhere) : undefined)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  // ---- 汇总统计(表头卡片) ----
  const balance = await db.select({ total: sql<number>`COALESCE(SUM(${usersTable.aiTokenBalance}), 0)` })
    .from(usersTable)
    .all()
  const consumedAll = await db.select({ total: sql<number>`COALESCE(SUM(${aiUsage.tokens}), 0)` })
    .from(aiUsage)
    .all()

  return {
    rows: rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      emailVerified: !!r.emailVerified,
      aiTokenBalance: r.aiTokenBalance,
      consumed: r.consumed ?? 0,
      /** 分 */
      recharged: r.recharged ?? 0,
      createdAt: Number(r.createdAt)
    })),
    total: total[0]?.n ?? 0,
    page,
    pageSize,
    sort,
    dir,
    q,
    stats: {
      totalUsers: total[0]?.n ?? 0,
      totalBalance: balance[0]?.total ?? 0,
      totalConsumed: consumedAll[0]?.total ?? 0
    }
  }
})
