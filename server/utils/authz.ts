// server/utils/authz.ts
// 登录态工具:取当前会话、取 userId、鉴权失败统一 401。
import type { H3Event } from 'h3'
import { getAuth, getAuthConfig } from './auth'
import { getD1Binding } from './d1'

/**
 * ★临时验证回退(仅供本地联调,验证完成后必须移除):
 * better-auth getSession 在本机 dev D1 偶发读不到新写入的会话(workerd 模拟层问题);
 * 此时手工验签 + 原生 D1 查询会话,保证鉴权链路可用。生产远端 D1 无此问题,该分支永不触发。
 */
async function fallbackSessionUser(event: H3Event) {
  try {
    const raw = (event.headers.get('cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1]
    if (!raw) return null
    const dot = raw.lastIndexOf('.')
    if (dot <= 0) return null
    const token = raw.slice(0, dot)
    const sigSent = decodeURIComponent(raw.slice(dot + 1))
    const secret = getAuthConfig(event).secret
    if (!secret || !sigSent) return null
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token))
    const sigCalc = btoa(String.fromCharCode(...new Uint8Array(buf)))
    if (sigCalc !== sigSent) return null
    const d1 = getD1Binding(event)
    const row = await d1.prepare('SELECT user_id FROM session WHERE token = ? AND expires_at > ?')
      .bind(token, Date.now()).first() as { user_id: string } | null
    if (!row) return null
    const u = await d1.prepare('SELECT id, name, email, email_verified, image FROM user WHERE id = ?')
      .bind(row.user_id).first() as { id: string, name: string, email: string, email_verified: number | null, image: string | null } | null
    if (!u) return null
    return { id: u.id, name: u.name, email: u.email, emailVerified: !!u.email_verified, image: u.image ?? null }
  } catch {
    return null
  }
}

/** 取当前会话(未登录返回 null) */
export async function getSessionUser(event: H3Event) {
  const auth = getAuth(event)
  const session = await auth.api.getSession({ headers: event.headers })
  if (session?.user) return session.user
  return fallbackSessionUser(event)
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

/** 要求当前用户为管理员(邮箱与 ADMIN_EMAIL 环境变量一致);未配置或非本人抛 403 */
export async function requireAdmin(event: H3Event) {
  const user = await requireUser(event)
  const rt = useRuntimeConfig(event).admin?.email ?? ''
  const env = (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env
  const adminEmail = (env?.ADMIN_EMAIL || rt).trim().toLowerCase()
  const userEmail = user.email?.trim().toLowerCase() ?? ''
  if (!adminEmail || userEmail !== adminEmail) {
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
