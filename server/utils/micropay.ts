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

/** 网关订单查询接口地址(参考 docs/payment-integration.md 与 scripts/query-order.mjs) */
export const GATEWAY_QUERY_URL = 'https://pay.microgg.cn/api/pay/query'

/** 回调/响应时间戳允许的最大偏差(秒,与官方 SDK verify() 一致,防重放) */
export const SIGN_TIMESTAMP_MAX_SKEW_S = 300

/** 秒级时间戳是否在允许偏差内 */
export function isTimestampFresh(timestamp: unknown): boolean {
  const ts = Number(timestamp)
  return Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) <= SIGN_TIMESTAMP_MAX_SKEW_S
}

export interface GatewayOrderInfo {
  /** 平台订单号 */
  tradeNo: string
  /** 商户订单号 */
  outTradeNo: string
  /** 1=已支付 */
  status: number
  /** 金额(元,字符串) */
  money: string
}

/**
 * 主动查询网关订单状态:商户私钥签名请求,平台公钥验签响应(含时间戳新鲜度)。
 * 请求/验签失败、响应过期、订单不存在均返回 null(调用方按"未确认"处理,不阻塞)。
 */
export async function queryGatewayOrder(event: H3Event, outTradeNo: string): Promise<GatewayOrderInfo | null> {
  const cfg = getMicropayConfig(event)
  if (!cfg.pid || !cfg.privateKey || !cfg.publicKey) return null

  const params: Record<string, string> = {
    pid: cfg.pid,
    out_trade_no: outTradeNo,
    timestamp: String(Math.floor(Date.now() / 1000))
  }
  params.sign = await signRSA(buildSignStr(params), cfg.privateKey)
  params.sign_type = 'RSA'

  let res: Response
  try {
    res = await fetch(GATEWAY_QUERY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    })
  } catch {
    return null
  }
  if (!res.ok) return null

  let data: Record<string, unknown>
  try {
    data = JSON.parse(await res.text()) as Record<string, unknown>
  } catch {
    return null
  }
  if (data.code !== 0 || typeof data.sign !== 'string') return null
  if (!isTimestampFresh(data.timestamp)) return null

  // 平台签名验签(字段集合与签名绑定一致,与 scripts/query-order.mjs 相同)
  const signParams: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' || typeof v === 'number') signParams[k] = v
  }
  const ok = await verifyRSA(buildSignStr(signParams), data.sign, cfg.publicKey)
  if (!ok) return null

  return {
    tradeNo: String(data.trade_no ?? ''),
    outTradeNo: String(data.out_trade_no ?? ''),
    status: Number(data.status ?? 0),
    money: String(data.money ?? '')
  }
}
