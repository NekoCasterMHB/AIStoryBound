// server/api/earnings/index.get.ts
// 当前用户收益账本列表(分页,倒序;含全部状态:待领取/已领取均保留)
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { and, count, desc, eq } from 'drizzle-orm'
import { earnings } from '../../db/schema'
import type { EarningsRow, EarningsStatus } from '../../../shared/earnings'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  const query = getQuery(event)

  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20))
  const status = query.status === 'pending' || query.status === 'claimed'
    ? query.status as EarningsStatus
    : undefined

  const cond = and(
    eq(earnings.userId, sessUser.id),
    ...(status ? [eq(earnings.status, status)] : [])
  )

  const totalRows = await db.select({ n: count() }).from(earnings).where(cond).all()
  const total = totalRows[0]?.n ?? 0

  const rows = await db.select()
    .from(earnings)
    .where(cond)
    .orderBy(desc(earnings.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  const mapRow = (r: typeof rows[number]): EarningsRow => ({
    id: r.id,
    amount: r.amount,
    sourceType: r.sourceType as EarningsRow['sourceType'],
    sourceId: r.sourceId,
    itemTitle: r.itemTitle,
    reason: r.reason,
    status: r.status as EarningsRow['status'],
    createdAt: Number(r.createdAt),
    claimedAt: r.claimedAt == null ? null : Number(r.claimedAt)
  })

  return { rows: rows.map(mapRow), total, page, pageSize }
})
