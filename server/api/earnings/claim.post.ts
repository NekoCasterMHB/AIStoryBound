// server/api/earnings/claim.post.ts
// 领取收益:把本人指定/全部 pending 收益结算进 ai_token_balance。
// 并发安全:一次 db.batch 内先「按待领金额加余额」再「置 claimed」——两条语句在同一事务按序执行,
// 加余额的子查询读到的仍是 claimed 前状态;重复请求时待领已空,子查询为 0,天然幂等不会双领。
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { user as usersTable, earnings } from '../../db/schema'

/** 目标范围:ids 缺省/null = 全部待领取;否则限指定 id(上限防滥用) */
const CLAIM_IDS_MAX = 200

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)
  const body = await readBody<{ ids?: unknown }>(event).catch(() => ({} as { ids?: unknown }))
  let ids: string[] | null = null
  if (body?.ids !== undefined && body.ids !== null) {
    if (!Array.isArray(body.ids)) {
      throw createError({ statusCode: 400, statusMessage: 'ids 必须是数组' })
    }
    ids = (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    if (ids.length === 0) {
      return { ok: true, credited: 0, claimedCount: 0 }
    }
    if (ids.length > CLAIM_IDS_MAX) {
      throw createError({ statusCode: 400, statusMessage: `单次最多领取 ${CLAIM_IDS_MAX} 笔` })
    }
  }

  // 范围条件(user_id + pending + 可选 id 列表),供两条语句共用
  const scope: SQL = ids
    ? sql`${earnings.userId} = ${sessUser.id} and ${earnings.status} = 'pending' and ${earnings.id} in (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`
    : sql`${earnings.userId} = ${sessUser.id} and ${earnings.status} = 'pending'`

  // 展示用预估(实际入账以 batch 内子查询为准):先取待领总额
  const sumRows = await db.select({
    total: sql<number>`coalesce(sum(${earnings.amount}), 0)`
  })
    .from(earnings)
    .where(scope)
    .all()
  const estimated = Number(sumRows[0]?.total ?? 0)
  if (estimated <= 0) {
    return { ok: true, credited: 0, claimedCount: 0 }
  }

  const now = new Date()
  const results = await db.batch([
    // 1) 先结算:加余额 = 范围内待领总额(此时记录尚未置 claimed,子查询拿到全量)
    db.update(usersTable)
      .set({
        aiTokenBalance: sql`${usersTable.aiTokenBalance} + coalesce((select sum(${earnings.amount}) from ${earnings} where ${scope}), 0)`
      })
      .where(eq(usersTable.id, sessUser.id)),
    // 2) 再置已领取(仅命中仍为 pending 的记录)
    db.update(earnings)
      .set({ status: 'claimed', claimedAt: now })
      .where(scope)
  ])
  const claimedCount = (results[1] as { meta: { changes: number } }).meta.changes

  return { ok: true, credited: claimedCount > 0 ? estimated : 0, claimedCount }
})
