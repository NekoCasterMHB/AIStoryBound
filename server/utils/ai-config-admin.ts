// server/utils/ai-config-admin.ts
// 管理员平台 AI 配置的公共校验与 apiKey 加密(create / update / test 三个接口共用)。
import type { H3Event } from 'h3'
import { encryptJson } from './crypto'
import { isAiApiFormat } from '../../shared/ai-config'

export interface AiConfigInput {
  name: string
  format: string
  baseUrl: string
  apiKey: string
  model: string
}

export type ValidateResult = { ok: true, value: AiConfigInput } | { ok: false, message: string }

/** 校验并规整配置表单;allowEmptyKey=true 时 apiKey 可留空(编辑场景表示不改);skipName=true 时名称不参与校验(测试连接场景) */
export function validateAiConfigInput(body: Record<string, unknown>, opts: { allowEmptyKey?: boolean, skipName?: boolean } = {}): ValidateResult {
  const name = String(body.name ?? '').trim()
  const format = String(body.format ?? 'chat').trim()
  const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '')
  const apiKey = String(body.apiKey ?? '').trim()
  const model = String(body.model ?? '').trim()

  if (!name && !opts.skipName) return { ok: false, message: '名称必填' }
  if (!isAiApiFormat(format)) return { ok: false, message: 'API 格式无效' }
  if (!baseUrl || !/^https?:\/\/.+/.test(baseUrl)) return { ok: false, message: 'baseUrl 必须是 http(s) 地址' }
  if (!opts.allowEmptyKey && !apiKey) return { ok: false, message: 'apiKey 必填' }
  if (apiKey && apiKey.length < 8) return { ok: false, message: 'apiKey 长度过短' }
  if (!model) return { ok: false, message: '模型名必填' }
  return { ok: true, value: { name, format, baseUrl, apiKey, model } }
}

/** apiKey 后 4 位(列表展示用,不暴露完整 key) */
export function apiKeyHint(apiKey: string): string {
  return apiKey.length <= 4 ? apiKey : apiKey.slice(-4)
}

/** AES-GCM 加密 apiKey(密钥由 BETTER_AUTH_SECRET 派生,见 crypto.ts;解密见 server/utils/ai.ts) */
export async function encryptApiKey(event: H3Event, apiKey: string) {
  return encryptJson(event, apiKey)
}
