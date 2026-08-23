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

/** 校验游戏会话归属当前用户(防止越权访问他人游戏),返回 userId */
export async function assertGameOwned(event: H3Event, game: { user_id: string | null }): Promise<string> {
  const userId = await requireUserId(event)
  if (game.user_id !== userId) {
    // 越权与不存在同响应,不泄露资源存在性
    throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  }
  return userId
}
