// server/api/profile/me.get.ts
// 当前用户信息 + 平台 token 余额 + 待领取收益汇总(个人中心「收益」角标数据源)
// 自建 AI 配置走 /api/profile/ai-config
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { eq, and, count, sql } from 'drizzle-orm'
import { user as usersTable, earnings } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  const row = await db.select().from(usersTable).where(eq(usersTable.id, sessUser.id)).get()

  // 待领取收益汇总:角标「新收益」提示(笔数 + 总额,仅 pending)
  const sumRows = await db.select({
    n: count(),
    total: sql<number>`coalesce(sum(${earnings.amount}), 0)`
  })
    .from(earnings)
    .where(and(
      eq(earnings.userId, sessUser.id),
      eq(earnings.status, 'pending')
    ))
    .all()
  const pending = sumRows[0]

  return {
    id: sessUser.id,
    name: sessUser.name,
    email: sessUser.email,
    aiTokenBalance: row?.aiTokenBalance ?? 0,
    pendingEarningsCount: pending?.n ?? 0,
    pendingEarningsTotal: Number(pending?.total ?? 0)
  }
})
