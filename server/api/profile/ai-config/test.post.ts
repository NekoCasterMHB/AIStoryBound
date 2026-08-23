// server/api/profile/ai-config/test.post.ts
// 测试连接:按 API 格式用提交的配置发一条极短请求,验证 key/baseUrl/model 可用。
// 不落库;失败返回可读原因(含 CORS/404/401 等常见错误)。
import { requireUser } from '../../../utils/authz'
import { testRelay } from '../../../utils/ai-relay'
import { isAiApiFormat } from '../../../../shared/ai-config'

interface TestBody {
  format?: string
  baseUrl?: string
  apiKey?: string
  model?: string
}

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = await readBody<TestBody>(event).catch(() => ({} as TestBody))

  const baseUrl = (body.baseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = (body.apiKey || '').trim()
  const model = (body.model || '').trim()
  if (!baseUrl || !apiKey || !model) {
    throw createError({ statusCode: 400, statusMessage: 'baseUrl / apiKey / model 均必填' })
  }
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    throw createError({ statusCode: 400, statusMessage: 'baseUrl 必须是 http(s) 地址' })
  }
  if (!isAiApiFormat(body.format)) {
    throw createError({ statusCode: 400, statusMessage: 'API 格式无效' })
  }

  return testRelay({ format: body.format, baseUrl, apiKey, model })
})
