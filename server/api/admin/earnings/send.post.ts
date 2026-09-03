// server/api/admin/earnings/send.post.ts
// 管理员手动发放收益(token):给指定用户或全部注册用户插入 earnings(pending, source_type=admin,
// 带自定义原因),收款用户在个人中心「收益」里领取后入账(与销售分成同一机制)。
// 全员发放按用户批量插入(每批 ≤100 行,单条 INSERT 多行 VALUES 控制 SQLite 变量上限)。
import { requireAdmin } from '../../../utils/authz'
import { useD1 } from '../../../utils/d1'
import { eq } from 'drizzle-orm'
import { user as usersTable, earnings } from '../../../db/schema'
import { uuid } from '../../../../shared/novel'
import { EARNINGS_AMOUNT_MAX, EARNINGS_REASON_MAX } from '../../../../shared/earnings'

/** 单条多行 INSERT 的用户数上限(SQLite 变量上限 ~999,每行 9 个绑定参数) */
const INSERT_CHUNK = 100

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const body = await readBody<{ userId?: unknown, all?: unknown, amount?: unknown, reason?: unknown }>(event)
    .catch(() => ({} as { userId?: unknown, all?: unknown, amount?: unknown, reason?: unknown }))

  const amount = typeof body?.amount === 'number' && Number.isInteger(body.amount) ? body.amount : NaN
  if (!Number.isInteger(amount) || amount <= 0 || amount > EARNINGS_AMOUNT_MAX) {
    throw createError({ statusCode: 400, statusMessage: `金额须为 1 ~ ${EARNINGS_AMOUNT_MAX} 的整数 token` })
  }

  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  if (reason.length > EARNINGS_REASON_MAX) {
    throw createError({ statusCode: 400, statusMessage: `原因不能超过 ${EARNINGS_REASON_MAX} 字` })
  }

  const grantAll = body?.all === true
  const userId = !grantAll && typeof body?.userId === 'string' && body.userId.length > 0 ? body.userId : null
  if (grantAll && userId) {
    throw createError({ statusCode: 400, statusMessage: '全员发放与指定用户只能二选一' })
  }
  if (!grantAll && !userId) {
    throw createError({ statusCode: 400, statusMessage: '缺少收款用户' })
  }

  const now = new Date()
  const row = (u: string) => ({
    id: uuid(),
    userId: u,
    amount,
    sourceType: 'admin' as const,
    sourceId: null,
    itemTitle: '管理员发放',
    reason: reason || null,
    status: 'pending' as const,
    createdAt: now,
    claimedAt: null
  })

  // 全员发放:对全部注册用户各生成一条待领取收益
  if (grantAll) {
    const targets = await db.select({ id: usersTable.id }).from(usersTable).all()
    if (targets.length === 0) {
      throw createError({ statusCode: 400, statusMessage: '暂无注册用户' })
    }
    for (let i = 0; i < targets.length; i += INSERT_CHUNK) {
      await db.insert(earnings).values(targets.slice(i, i + INSERT_CHUNK).map(t => row(t.id))).run()
    }
    return { ok: true, count: targets.length }
  }

  const target = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId!)).get()
  if (!target) throw createError({ statusCode: 404, statusMessage: '收款用户不存在' })

  const id = uuid()
  await db.insert(earnings).values(row(userId!)).run()
  return { ok: true, id }
})
