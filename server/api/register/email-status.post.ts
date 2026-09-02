// server/api/register/email-status.post.ts
// 注册预检:查询邮箱是否已注册。背景——better-auth 配了 requireEmailVerification 后,
// 对已存在邮箱的 signUp 走「泛化重复响应」(返回伪造成功防枚举),不创建用户也不发验证码,
// 前端无法从 signUp 响应区分,用户会卡在等邮件且无提示。故注册前先查一次:已存在则前端直接
// 提示「该邮箱已注册,请直接登录」并引导登录,不再发起 signUp。
// 限流抬高批量枚举邮箱的滥用成本(见 server/utils/rate-limit.ts)。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { user as usersTable } from '../../db/schema'
import { createRateLimiter } from '../../utils/rate-limit'

const limiter = createRateLimiter({
  windowMs: 60_000,
  limit: 10,
  message: '查询过于频繁,请稍后再试'
})

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event).catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: '邮箱格式无效' })
  }
  // 按 IP + 邮箱双键限流(防枚举脚本批量探测)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  limiter.hit(`${ip}:${email}`)

  const db = useD1(event)
  const hit = await db.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.email, email))
    .get()
  return { exists: !!hit }
})
