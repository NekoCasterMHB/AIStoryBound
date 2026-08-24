// server/utils/auth.ts
// Better Auth 实例:邮箱+密码 与 邮箱验证码 双通道登录/注册。
// - 数据库:D1 + Drizzle 适配器(SQLite 方言)
// - 注册即发验证码(emailOTP overrideDefaultEmailVerification,requireEmailVerification 强制验证后才可登录)
// - 新用户注册赠送 FREE_TOKEN_GRANT 平台 token 配额
// 密钥从 env(BETTER_AUTH_SECRET)或 runtimeConfig.auth 读取;回调域名默认不配置,
// 由 better-auth 按请求 Host 自动推断(本地 dev 即 localhost:4569,生产即部署域名);
// 如需固定域名(如前后端分离部署),仍可用 BETTER_AUTH_URL / runtimeConfig.auth.baseUrl 覆盖。
// Worker 内 binding 与配置在进程生命周期内稳定,首次取到后缓存实例,避免每次请求重建。
import type { H3Event } from 'h3'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { emailOTP } from 'better-auth/plugins'
import * as schema from '../db/schema'
import { user } from '../db/schema'
import { getD1Binding } from './d1'
import { getEmailCtx, sendOtpEmail } from './email'

/** 注册赠送的平台 AI 配额(token 数)。约等于 1~2 本 20 万字小说的生成量,产品决策可调 */
export const FREE_TOKEN_GRANT = 300_000

export interface AuthEnvConfig {
  secret: string
  /** undefined 时由 better-auth 按请求 Host 自动推断 */
  baseUrl?: string
}

/** 读取认证配置(env 优先,runtimeConfig 兜底;baseUrl 未配置时自动适配请求域名) */
export function getAuthConfig(event: H3Event): AuthEnvConfig {
  const env = (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env
  const rt = (useRuntimeConfig(event).auth ?? {}) as { secret?: string, baseUrl?: string }
  return {
    secret: env?.BETTER_AUTH_SECRET || rt.secret || '',
    baseUrl: env?.BETTER_AUTH_URL || rt.baseUrl || undefined
  }
}

function createAuth(db: D1Database, cfg: AuthEnvConfig, emailCtx: ReturnType<typeof getEmailCtx>) {
  const orm = drizzle(db, { schema })
  return betterAuth({
    appName: 'AI SpankWorld',
    secret: cfg.secret,
    baseURL: cfg.baseUrl,
    database: drizzleAdapter(orm, { provider: 'sqlite' }),
    emailAndPassword: {
      enabled: true,
      // 邮箱未验证前不允许登录(验证走验证码,见 emailOTP.overrideDefaultEmailVerification)
      requireEmailVerification: true
    },
    plugins: [
      emailOTP({
        // 验证码邮件走 Cloudflare Email Service — Email Sending REST API;未配置密钥时打印日志
        sendVerificationOTP: async ({ email, otp, type }) => {
          await sendOtpEmail(email, otp, type, emailCtx)
        },
        // 验证码登录不自动注册新账号(必须先通过注册模态框注册)
        disableSignUp: true,
        // 把默认的邮件链接验证切换为验证码验证
        overrideDefaultEmailVerification: true
      })
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (u) => {
            // 注册赠送 token 配额(幂等:首次创建时余额为 0)
            await orm.update(user)
              .set({ aiTokenBalance: FREE_TOKEN_GRANT })
              .where(eq(user.id, u.id))
              .run()
          }
        }
      }
    }
  })
}

type AuthInstance = ReturnType<typeof createAuth>

let cachedAuth: AuthInstance | null = null

/** 取 Auth 实例(Better Auth 核心 API:handler / api.getSession 等) */
export function getAuth(event: H3Event): AuthInstance {
  if (cachedAuth) return cachedAuth
  const cfg = getAuthConfig(event)
  if (!cfg.secret) {
    throw createError({
      statusCode: 500,
      statusMessage: '缺少 BETTER_AUTH_SECRET(至少 32 位随机字符串,本地 .dev.vars / wrangler secret / NUXT_AUTH_SECRET)'
    })
  }
  cachedAuth = createAuth(getD1Binding(event), cfg, getEmailCtx(event))
  return cachedAuth
}
