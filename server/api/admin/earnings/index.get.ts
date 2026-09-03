// server/api/admin/earnings/index.get.ts
// 管理员查看收益账本(分页;可按收款人姓名/邮箱搜索,按状态过滤;带收款人快照)
import { requireAdmin } from '../../../utils/authz'
import { useD1 } from '../../../utils/d1'
import { and, count, desc, eq, like, or } from 'drizzle-orm'
import { user as usersTable, earnings } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const query = getQuery(event)

  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20))
  const status = query.status === 'pending' || query.status === 'claimed' ? String(query.status) : undefined
  const q = typeof query.q === 'string' ? query.q.trim() : ''

  const conds = []
  if (status) conds.push(eq(earnings.status, status))
  if (q) {
    const esc = q.replace(/[\\%_]/g, '\\$&')
    conds.push(or(
      like(usersTable.name, `%${esc}%`),
      like(usersTable.email, `%${esc}%`)
    ))
  }

  const cond = conds.length > 0 ? and(...conds) : undefined

  const totalRows = await db.select({ n: count() })
    .from(earnings)
    .leftJoin(usersTable, eq(usersTable.id, earnings.userId))
    .where(cond)
    .all()
  const total = totalRows[0]?.n ?? 0

  const rows = await db.select({
    id: earnings.id,
    userId: earnings.userId,
    recipientName: usersTable.name,
    recipientEmail: usersTable.email,
    amount: earnings.amount,
    sourceType: earnings.sourceType,
    itemTitle: earnings.itemTitle,
    reason: earnings.reason,
    status: earnings.status,
    createdAt: earnings.createdAt,
    claimedAt: earnings.claimedAt
  })
    .from(earnings)
    .leftJoin(usersTable, eq(usersTable.id, earnings.userId))
    .where(cond)
    .orderBy(desc(earnings.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  return {
    rows: rows.map(r => ({
      id: r.id,
      userId: r.userId,
      recipientName: r.recipientName,
      recipientEmail: r.recipientEmail,
      amount: r.amount,
      sourceType: r.sourceType,
      itemTitle: r.itemTitle,
      reason: r.reason,
      status: r.status,
      createdAt: Number(r.createdAt),
      claimedAt: r.claimedAt == null ? null : Number(r.claimedAt)
    })),
    total,
    page,
    pageSize
  }
})
