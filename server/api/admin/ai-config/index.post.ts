// 管理员创建平台 AI 配置;首条配置自动启用(之后创建的默认停用,由「启用」按钮动态切换)。
import { count } from 'drizzle-orm'
import { uuid } from '../../../../shared/novel'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { validateAiConfigInput, apiKeyHint, encryptApiKey } from '../../../utils/ai-config-admin'
import { aiProviderConfigs } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: '参数错误' })
  }
  const v = validateAiConfigInput(body as Record<string, unknown>)
  if (!v.ok) {
    throw createError({ statusCode: 400, statusMessage: v.message })
  }
  const { name, format, baseUrl, apiKey, model } = v.value

  const db = useD1(event)
  const existing = await db.select({ n: count() }).from(aiProviderConfigs).all()
  const isFirst = (existing[0]?.n ?? 0) === 0

  const { ciphertext, iv } = await encryptApiKey(event, apiKey)
  const now = new Date()
  await db.insert(aiProviderConfigs).values({
    id: uuid(),
    name,
    format,
    baseUrl,
    model,
    apiKeyCiphertext: ciphertext,
    apiKeyIv: iv,
    apiKeyHint: apiKeyHint(apiKey),
    active: isFirst ? 1 : 0,
    createdBy: admin.id,
    createdAt: now,
    updatedAt: now
  }).run()

  return { ok: true, active: isFirst }
})
