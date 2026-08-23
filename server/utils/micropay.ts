// server/utils/micropay.ts
// 微支付网关(microgg.cn)签名工具(参考 docs/payment-integration.md):
// - 提交参数:ASCII 排序拼串 → 商户私钥 RSA-SHA256 签名(base64)
// - 回调参数:平台公钥验签,防第三方伪造 notify
// 全部基于 WebCrypto(Worker 原生,无需 node:crypto)。密钥支持裸 base64 / \n 字面量 / 完整 PEM。
import type { H3Event } from 'h3'

export interface MicropayConfig {
  pid: string
  privateKey: string
  publicKey: string
}

/** 读取支付网关配置(env 优先,runtimeConfig 兜底);未配置时 pid 为空 */
export function getMicropayConfig(event: H3Event): MicropayConfig {
  const env = (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env
  const rt = (useRuntimeConfig(event).micropay ?? {}) as { pid?: string, privateKey?: string, publicKey?: string }
  return {
    pid: env?.MICROPAY_PID || rt.pid || '',
    privateKey: env?.MICROPAY_PRIVATE_KEY || rt.privateKey || '',
    publicKey: env?.MICROPAY_PUBLIC_KEY || rt.publicKey || ''
  }
}

/** 构造待签名字符串:按 ASCII key 排序,排除 sign/sign_type 与空值 */
export function buildSignStr(params: Record<string, string | number | undefined>): string {
  return Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type')
    .filter((k) => {
      const v = params[k]
      return v !== undefined && v !== null && v !== ''
    })
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&')
}

function pemToRaw(pem: string): string {
  return pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+KEY-----/, '')
    .replace(/-----END [A-Z ]+KEY-----/, '')
    .replace(/\s+/g, '')
}

function toUint8Array(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const encoder = new TextEncoder()

async function importPrivateKey(raw: string): Promise<CryptoKey> {
  const pem = raw.includes('-----') ? raw : `-----BEGIN PRIVATE KEY-----\n${pemToRaw(raw)}\n-----END PRIVATE KEY-----`
  const der = pemToRaw(pem)
  return crypto.subtle.importKey(
    'pkcs8',
    toUint8Array(der),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

async function importPublicKey(raw: string): Promise<CryptoKey> {
  const pem = raw.includes('-----') ? raw : `-----BEGIN PUBLIC KEY-----\n${pemToRaw(raw)}\n-----END PUBLIC KEY-----`
  const der = pemToRaw(pem)
  return crypto.subtle.importKey(
    'spki',
    toUint8Array(der),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** RSA-SHA256 签名(商户私钥),返回 base64 */
export async function signRSA(signStr: string, privateKeyPem: string): Promise<string> {
  const key = await importPrivateKey(privateKeyPem)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signStr))
  return toBase64(new Uint8Array(sig))
}

/** RSA-SHA256 验签(平台公钥) */
export async function verifyRSA(signStr: string, sign: string, publicKeyPem: string): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyPem)
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, toUint8Array(sign), encoder.encode(signStr))
  } catch {
    return false
  }
}

/** 生成商户订单号:时间戳 + 6 位随机数(共 19 位数字,网关幂等键) */
export function generateOutTradeNo(): string {
  const ts = Date.now()
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `${ts}${rand}`
}
