// server/utils/d1.ts
// 统一的 D1 访问入口
// - 本地 dev:  nitro-cloudflare-dev 通过 getPlatformProxy 提供 event.context.cloudflare.env
// - 部署:      Nitro cloudflare preset 提供相同结构的 env(D1 binding 名 DB)
// 返回 Drizzle 实例(基于 drizzle-orm/d1)
import { drizzle } from 'drizzle-orm/d1'
import type { H3Event } from 'h3'
import * as schema from '../db/schema'

/** 从请求上下文中取出 D1 binding */
export function getD1Binding(event: H3Event): D1Database {
  const env = (event.context as any).cloudflare?.env as Env | undefined
  if (env?.DB) {
    return env.DB
  }
  const g = globalThis as any
  if (g.__env__?.DB) {
    return g.__env__.DB as D1Database
  }
  throw createError({ statusCode: 500, statusMessage: 'D1 binding (DB) not available' })
}

/** 在事件上下文中获取 Drizzle 实例 */
export function useD1(event: H3Event) {
  return drizzle(getD1Binding(event), { schema })
}
