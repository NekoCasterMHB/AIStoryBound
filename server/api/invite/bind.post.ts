// server/api/invite/bind.post.ts
// 填写邀请码绑定:每人只能绑定一次(被邀请人主键唯一约束),绑定成功双方各得 INVITE_REWARD_TOKENS。
// 原子 db.batch:插关系 + 双方余额入账,任一失败整批回滚;并发重复绑定由唯一约束兜底转 409。
// 失败尝试限流(复用兑换码模式),防在线爆破他人邀请码。
import { requireUser } from '../../utils/authz'
import { useD1 } from '../../utils/d1'
import { createRateLimiter } from '../../utils/rate-limit'
import { user as usersTable, inviteCodes, inviteRelations } from '../../db/schema'
import { normalizeRedeemCode } from '../../../shared/redeem-code'
import { INVITE_REWARD_TOKENS } from '../../../shared/invite'
import { eq, sql } from 'drizzle-orm'

// 绑定尝试限流:单用户 10 分钟内失败 ≥5 次返回 429;成功即清零
const bindThrottle = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  message: '尝试次数过多,请 10 分钟后再试'
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const body = await readBody<{ code?: unknown }>(event).catch(() => ({} as { code?: unknown }))
  const code = typeof body?.code === 'string' ? normalizeRedeemCode(body.code) : ''
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: '请输入邀请码' })
  }

  bindThrottle.check(me.id)

  const db = useD1(event)

  try {
    // 查码得邀请人
    const codeRows = await db.select({ userId: inviteCodes.userId }).from(inviteCodes).where(eq(inviteCodes.code, code)).all()
    const inviterId = codeRows[0]?.userId
    if (!inviterId) {
      throw createError({ statusCode: 400, statusMessage: '邀请码不存在' })
    }
    if (inviterId === me.id) {
      throw createError({ statusCode: 400, statusMessage: '不能填写自己的邀请码' })
    }

    // 已绑定预检(并发竞态由下方唯一约束兜底)
    const relRows = await db.select({ inviteeId: inviteRelations.inviteeId })
      .from(inviteRelations)
      .where(eq(inviteRelations.inviteeId, me.id))
      .all()
    if (relRows.length > 0) {
      throw createError({ statusCode: 409, statusMessage: '你已填写过邀请码,每人只能绑定一次' })
    }

    const now = new Date()
    await db.batch([
      // 关系先行(PK 冲突 = 已绑定,整批回滚,双方不入账)
      db.insert(inviteRelations).values({ inviteeId: me.id, inviterId, createdAt: now }),
      db.update(usersTable)
        .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${INVITE_REWARD_TOKENS}` })
        .where(eq(usersTable.id, me.id)),
      db.update(usersTable)
        .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${INVITE_REWARD_TOKENS}` })
        .where(eq(usersTable.id, inviterId))
    ])

    const inviterRows = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, inviterId)).all()
    bindThrottle.clear(me.id)
    return { ok: true, inviterName: inviterRows[0]?.name ?? null, reward: INVITE_REWARD_TOKENS }
  } catch (e) {
    // 唯一约束冲突 = 并发下重复绑定,收敛为 409
    const msg = (e as Error)?.message ?? ''
    if (/UNIQUE constraint failed.*invite_relations|PRIMARY KEY.*invite_relations/i.test(msg)) {
      throw createError({ statusCode: 409, statusMessage: '你已填写过邀请码,每人只能绑定一次' })
    }
    if ((e as { statusCode?: number }).statusCode === 400) bindThrottle.record(me.id)
    throw e
  }
})
