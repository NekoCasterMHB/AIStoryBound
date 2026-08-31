// server/utils/ai-fingerprint.ts
// 用户自建 AI 配置的验证指纹:个人中心测试连接通过后服务端留痕(ai_config_verifications),
// /api/ai/chat 用户模式凭指纹准入——免计费通道只对「服务端验证过的配置」开放,可撤销、可管控。
// 指纹 = HMAC-SHA256(userId|format|baseUrl|apiKey|model),密钥由 BETTER_AUTH_SECRET 经 HKDF 派生
// (与 crypto.ts 的 AES 加密密钥同源不同用途,salt/info 区分);任一字段变更即失效,需重新测试。
// 注意:指纹挡不住「真实可用的免费端点」(测试同样能通过),只挡伪造/未验证配置直接打免计费通道。
import { getAuthConfig } from './auth'
import type { H3Event } from 'h3'
import type { AiApiFormat } from '../../shared/ai-config'

const HKDF_SALT = 'aiSpankWorld-ai-fingerprint-salt'
const HKDF_INFO = 'aiSpankWorld-ai-fingerprint-key'

async function hmacKey(event: H3Event): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(getAuthConfig(event).secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  )
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export interface FingerprintConfig {
  format: AiApiFormat
  baseUrl: string
  apiKey: string
  model: string
}

/** 规整参与指纹与转发的字段;测试端点与 chat 端点必须用同一规整,否则指纹对不上 */
export function normalizeRelayConfig(cfg: FingerprintConfig): FingerprintConfig {
  return {
    format: cfg.format,
    baseUrl: cfg.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: cfg.apiKey.trim(),
    model: cfg.model.trim()
  }
}

/** 计算某用户某配置的验证指纹(hex) */
export async function aiConfigFingerprint(event: H3Event, userId: string, cfg: FingerprintConfig): Promise<string> {
  const key = await hmacKey(event)
  const n = normalizeRelayConfig(cfg)
  const data = new TextEncoder().encode([userId, n.format, n.baseUrl, n.apiKey, n.model].join('|'))
  const sig = await crypto.subtle.sign('HMAC', key, data)
  return toHex(new Uint8Array(sig))
}
