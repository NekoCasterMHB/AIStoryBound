// server/utils/r2.ts
// 统一的 R2 访问入口(Skill 商城文件存储;binding: SKILL_FILES,见 wrangler.toml)
// - 本地 dev:  nitro-cloudflare-dev 通过 getPlatformProxy 提供 event.context.cloudflare.env(remote=true 直连云端真桶)
// - 部署:      Nitro cloudflare preset 提供相同结构的 env
import type { H3Event } from 'h3'

/** 从请求上下文中取出 SKILL_FILES R2 bucket binding */
export function getSkillBucket(event: H3Event): R2Bucket {
  const ctx = event.context as unknown as { cloudflare?: { env?: Env } | undefined }
  const env = ctx.cloudflare?.env
  if (env?.SKILL_FILES) {
    return env.SKILL_FILES
  }
  throw createError({ statusCode: 500, statusMessage: 'R2 binding (SKILL_FILES) not available' })
}
