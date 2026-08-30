// 测试平台 AI 配置连接:传 id 时以已存配置为底,表单字段(含新 apiKey)非空则覆盖;不传 id 则用表单完整字段。
// 复用 ai-relay 的 testRelay(三种 API 格式通用),不落库。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { testRelay } from '../../../utils/ai-relay'
import { decryptJson } from '../../../utils/crypto'
import { validateAiConfigInput } from '../../../utils/ai-config-admin'
import { isAiApiFormat, type AiApiFormat } from '../../../../shared/ai-config'
import { aiProviderConfigs } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: '参数错误' })
  }
  const raw = body as Record<string, unknown>

  let format: AiApiFormat
  let baseUrl: string
  let apiKey: string
  let model: string

  const id = typeof raw.id === 'string' ? raw.id : undefined
  if (id) {
    const rows = await useD1(event).select()
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.id, id))
      .all()
    const row = rows[0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: '配置不存在' })
    }
    const storedKey = await decryptJson<string>(event, row.apiKeyCiphertext, row.apiKeyIv)
    if (!storedKey) {
      throw createError({ statusCode: 500, statusMessage: '已存配置解密失败,请重新填写 apiKey 保存' })
    }
    format = isAiApiFormat(row.format) ? row.format : 'chat'
    baseUrl = row.baseUrl.replace(/\/+$/, '')
    apiKey = storedKey
    model = row.model
    // 表单显式提供的字段覆盖已存值(apiKey 留空 = 用已存 key 测试)
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) baseUrl = raw.baseUrl.trim().replace(/\/+$/, '')
    if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) apiKey = raw.apiKey.trim()
    if (typeof raw.model === 'string' && raw.model.trim()) model = raw.model.trim()
    if (isAiApiFormat(raw.format)) format = raw.format
    if (!baseUrl || !/^https?:\/\/.+/.test(baseUrl)) {
      throw createError({ statusCode: 400, statusMessage: 'baseUrl 必须是 http(s) 地址' })
    }
    if (!apiKey || !model) {
      throw createError({ statusCode: 400, statusMessage: 'apiKey / model 必填' })
    }
  } else {
    const v = validateAiConfigInput(raw, { skipName: true })
    if (!v.ok) {
      throw createError({ statusCode: 400, statusMessage: v.message })
    }
    format = v.value.format as AiApiFormat
    baseUrl = v.value.baseUrl
    apiKey = v.value.apiKey
    model = v.value.model
  }

  return testRelay({ format, baseUrl, apiKey, model })
})
