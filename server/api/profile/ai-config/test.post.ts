// server/api/profile/ai-config/test.post.ts
// 测试连接:按 API 格式用提交的配置发一条极短请求,验证 key/baseUrl/model 可用。
// 不落配置本身;测试通过时把配置指纹写入 ai_config_verifications 留痕,
// /api/ai/chat 用户模式凭指纹准入(见 server/utils/ai-fingerprint.ts)。
// 限流:每用户每分钟 5 次——该端点会让服务器代发任意 URL 请求并回显上游响应,
// 限流抬高被当外部探测跳板的滥用成本(见 server/utils/rate-limit.ts)。
import { and, eq, sql } from 'drizzle-orm'
import { requireUser } from '../../../utils/authz'
import { testRelay } from '../../../utils/ai-relay'
import { isAiApiFormat, AI_USER_CONFIG_LIMIT } from '../../../../shared/ai-config'
import { createRateLimiter } from '../../../utils/rate-limit'
import { aiConfigFingerprint } from '../../../utils/ai-fingerprint'
import { aiConfigVerifications } from '../../../db/schema'
import { useD1 } from '../../../utils/d1'
import { uuid } from '../../../../shared/novel'

const testThrottle = createRateLimiter({
  windowMs: 60_000,
  limit: 5,
  message: '测试过于频繁,请稍后再试'
})

interface TestBody {
  format?: string
  baseUrl?: string
  apiKey?: string
  model?: string
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  testThrottle.hit(`ai-config-test:${user.id}`)
  const body = await readBody<TestBody>(event).catch(() => ({} as TestBody))

  const baseUrl = (body.baseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = (body.apiKey || '').trim()
  const model = (body.model || '').trim()
  if (!baseUrl || !apiKey || !model) {
    throw createError({ statusCode: 400, statusMessage: 'baseUrl / apiKey / model 均必填' })
  }
  if (!/^https:\/\/.+/i.test(baseUrl)) {
    throw createError({ statusCode: 400, statusMessage: 'baseUrl 必须是 https 地址' })
  }
  if (!isAiApiFormat(body.format)) {
    throw createError({ statusCode: 400, statusMessage: 'API 格式无效' })
  }

  const cfg = { format: body.format, baseUrl, apiKey, model }
  const result = await testRelay(cfg)

  // 测试通过:落库验证指纹(同指纹刷新时间;每用户滚动保留 AI_USER_CONFIG_LIMIT 条,淘汰最旧)
  if (result.ok) {
    const fingerprint = await aiConfigFingerprint(event, user.id, cfg)
    const db = useD1(event)
    const now = new Date()
    await db.batch([
      db.delete(aiConfigVerifications)
        .where(and(eq(aiConfigVerifications.userId, user.id), eq(aiConfigVerifications.fingerprint, fingerprint))),
      db.insert(aiConfigVerifications).values({ id: uuid(), userId: user.id, fingerprint, verifiedAt: now })
    ])
    // 滚动淘汰最旧(超出上限的兜底清理,非关键路径,独立执行)
    await db.run(sql`DELETE FROM ai_config_verifications WHERE user_id = ${user.id} AND id NOT IN (
      SELECT id FROM ai_config_verifications WHERE user_id = ${user.id} ORDER BY verified_at DESC LIMIT ${AI_USER_CONFIG_LIMIT}
    )`)
  }

  return result
})
