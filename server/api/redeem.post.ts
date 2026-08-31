// server/api/redeem.post.ts
// 兑换码兑换 token:校验码有效性 → 原子入账(used_count+1 / 记兑换记录 / 用户余额叠加)。
// D1 batch 原子提交:任一语句失败整体回滚,不会出现"码被消耗但没到账"。
import { normalizeRedeemCode } from '../../shared/redeem-code'
import { uuid } from '../../shared/novel'
import { useD1 } from '../utils/d1'
import { requireUser } from '../utils/authz'
import { createRateLimiter } from '../utils/rate-limit'
import { redeemCodes, redeemCodeRedemptions, user as usersTable } from '../db/schema'
import { and, count, eq, sql } from 'drizzle-orm'

// 兑换尝试限流:单用户 10 分钟内失败 ≥5 次返回 429,防止兑换码在线爆破;兑换成功即清零。
// 实现见 server/utils/rate-limit.ts(进程内存,per-isolate,计数不跨 isolate,仅抬高爆破成本)。
const redeemThrottle = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  message: '尝试次数过多,请 10 分钟后再试'
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ code?: string }>(event).catch(() => null)
  const code = normalizeRedeemCode(body?.code ?? '')
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: '请输入兑换码' })
  }

  redeemThrottle.check(user.id)

  const db = useD1(event)
  const now = new Date()

  try {
    const tokens = await claimRedeemCode(db, user.id, code, now)
    redeemThrottle.clear(user.id)
    return { ok: true, tokens }
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 400) redeemThrottle.record(user.id)
    throw e
  }
})

/** 校验码有效性并原子入账,返回入账 token 数;校验失败抛 400 */
async function claimRedeemCode(db: ReturnType<typeof useD1>, userId: string, code: string, now: Date): Promise<number> {
  // 1) 查码与状态校验
  const rows = await db.select().from(redeemCodes).where(eq(redeemCodes.code, code)).all()
  const rc = rows[0]
  if (!rc || rc.disabled === 1) {
    throw createError({ statusCode: 400, statusMessage: '无效的兑换码' })
  }
  if (rc.expiresAt && rc.expiresAt.getTime() < now.getTime()) {
    throw createError({ statusCode: 400, statusMessage: '兑换码已过期' })
  }
  if (rc.maxUses !== null && rc.usedCount >= rc.maxUses) {
    throw createError({ statusCode: 400, statusMessage: '兑换码已被领完' })
  }

  // 2) 每人限次(先查给出友好报错;并发兜底由 3) 的原子入库保证)
  const userCounts = await db.select({ n: count() })
    .from(redeemCodeRedemptions)
    .where(and(
      eq(redeemCodeRedemptions.codeId, rc.id),
      eq(redeemCodeRedemptions.userId, userId)
    ))
    .all()
  if ((userCounts[0]?.n ?? 0) >= rc.perUserLimit) {
    throw createError({ statusCode: 400, statusMessage: '每个账号限领一次' })
  }

  // 3) 原子入账:条件占位(防并发超发)→ 记兑换记录 → 余额叠加
  const results = await db.batch([
    db.update(redeemCodes)
      .set({ usedCount: sql`${redeemCodes.usedCount} + 1`, updatedAt: now })
      .where(and(
        eq(redeemCodes.id, rc.id),
        eq(redeemCodes.disabled, 0),
        ...(rc.maxUses !== null ? [sql`${redeemCodes.usedCount} < ${rc.maxUses}`] : []),
        ...(rc.expiresAt !== null ? [sql`${redeemCodes.expiresAt} > ${now.getTime()}`] : [])
      )),
    db.insert(redeemCodeRedemptions).values({
      id: uuid(),
      codeId: rc.id,
      userId,
      tokens: rc.tokens,
      createdAt: now
    }),
    db.update(usersTable)
      .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${rc.tokens}` })
      .where(eq(usersTable.id, userId))
  ])
  const claimChanges = (results[0] as { meta: { changes: number } }).meta.changes
  if (claimChanges === 0) {
    throw createError({ statusCode: 400, statusMessage: '兑换码已被领完' })
  }

  return rc.tokens
}
