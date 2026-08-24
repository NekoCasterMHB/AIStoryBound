// server/utils/crypto.ts
// 用户自建 AI 配置的对称加密:密钥由 BETTER_AUTH_SECRET 经 HKDF 派生,AES-256-GCM 加密。
// 仅防静态泄露(库文件/备份);转发时服务器必然接触明文,属架构固有边界。
import { getAuthConfig } from './auth'
import type { H3Event } from 'h3'

const HKDF_SALT = 'aiSpankWorld-ai-config-salt'
const HKDF_INFO = 'aiSpankWorld-ai-config-key'

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(HKDF_SALT),
      info: enc.encode(HKDF_INFO)
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** 加密任意 JSON 对象;返回 base64 的密文与 IV */
export async function encryptJson(event: H3Event, obj: unknown): Promise<{ ciphertext: string, iv: string }> {
  const key = await deriveKey(getAuthConfig(event).secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(obj))
  )
  return { ciphertext: toBase64(new Uint8Array(ct)), iv: toBase64(iv) }
}

/** 解密 encryptJson 的产物;失败返回 null(密钥变更/数据损坏) */
export async function decryptJson<T = unknown>(event: H3Event, ciphertext: string, iv: string): Promise<T | null> {
  try {
    const key = await deriveKey(getAuthConfig(event).secret)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) },
      key,
      fromBase64(ciphertext)
    )
    return JSON.parse(new TextDecoder().decode(pt)) as T
  } catch {
    return null
  }
}
