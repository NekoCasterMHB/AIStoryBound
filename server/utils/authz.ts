// server/utils/authz.ts
// 登录态工具:取当前会话、取 userId、鉴权失败统一 401。
import type { H3Event } from 'h3'
import { getAuth } from './auth'

/** 取当前会话(未登录返回 null) */
export async function getSessionUser(event: H3Event) {
  const auth = getAuth(event)
  const session = await auth.api.getSession({ headers: event.headers })
  return session?.user ?? null
}

/** 要求已登录,返回 userId;未登录抛 401 */
export async function requireUserId(event: H3Event): Promise<string> {
  const user = await getSessionUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: '请先登录' })
  }
  return user.id
}

/** 要求已登录,返回完整用户信息 */
export async function requireUser(event: H3Event) {
  const user = await getSessionUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: '请先登录' })
  }
  return user
}

/** 管理员环境变量名(与 wrangler.toml [vars] / .env.example 保持一致) */
export const ADMIN_EMAIL_ENV = 'ADMIN_EMAIL'

/**
 * 判断当前用户是否为管理员(邮箱与 ADMIN_EMAIL 环境变量一致)。
 * 未配置 ADMIN_EMAIL 时恒为 false(与 requireAdmin 的 403 行为一致)。
 * 传入已取好的 user(如 requireAdmin 内复用)可避免二次查会话。
 */
export async function isAdmin(event: H3Event, user?: Awaited<ReturnType<typeof requireUser>>) {
  const current = user ?? await requireUser(event)
  const rt = useRuntimeConfig(event).admin?.email ?? ''
  const env = (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env
  const adminEmail = (env?.ADMIN_EMAIL || rt).trim().toLowerCase()
  const userEmail = current.email?.trim().toLowerCase() ?? ''
  return !!adminEmail && userEmail === adminEmail
}

/** 要求当前用户为管理员(邮箱与 ADMIN_EMAIL 环境变量一致);未配置或非本人抛 403 */
export async function requireAdmin(event: H3Event) {
  const user = await requireUser(event)
  if (!(await isAdmin(event, user))) {
    throw createError({ statusCode: 403, statusMessage: '无权限' })
  }
  return user
}

/** 校验游戏会话归属当前用户(防止越权访问他人游戏),返回 userId */
export async function assertGameOwned(event: H3Event, game: { user_id: string | null }): Promise<string> {
  const userId = await requireUserId(event)
  if (game.user_id !== userId) {
    // 越权与不存在同响应,不泄露资源存在性
    throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  }
  return userId
}
