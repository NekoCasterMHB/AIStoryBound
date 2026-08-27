// 管理员更新平台 AI 配置;apiKey 留空 = 保持原密文不变,提供新 key 则重新加密。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { validateAiConfigInput, apiKeyHint, encryptApiKey } from '../../../utils/ai-config-admin'
import { aiProviderConfigs } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  }
  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: '参数错误' })
  }
  const v = validateAiConfigInput(body as Record<string, unknown>, { allowEmptyKey: true })
  if (!v.ok) {
    throw createError({ statusCode: 400, statusMessage: v.message })
  }
  const { name, format, baseUrl, apiKey, model } = v.value

  const db = useD1(event)
  const rows = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).all()
  const row = rows[0]
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: '配置不存在' })
  }

  let keyCiphertext = row.apiKeyCiphertext
  let keyIv = row.apiKeyIv
  let keyHint = row.apiKeyHint
  if (apiKey) {
    const enc = await encryptApiKey(event, apiKey)
    keyCiphertext = enc.ciphertext
    keyIv = enc.iv
    keyHint = apiKeyHint(apiKey)
  }

  await db.update(aiProviderConfigs).set({
    name,
    format,
    baseUrl,
    model,
    apiKeyCiphertext: keyCiphertext,
    apiKeyIv: keyIv,
    apiKeyHint: keyHint,
    updatedAt: new Date()
  }).where(eq(aiProviderConfigs.id, id)).run()

  return { ok: true }
})
