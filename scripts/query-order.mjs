// scripts/query-order.mjs — 用商户私钥调用网关订单查询接口,自检密钥与签名链路
// 用法: node scripts/query-order.mjs <out_trade_no>
import { readFileSync } from 'node:fs'

const [, , outTradeNo] = process.argv
if (!outTradeNo) {
  console.error('用法: node scripts/query-order.mjs <out_trade_no>')
  process.exit(1)
}

const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
function getVar(k) {
  const m = vars.match(new RegExp(`^${k}=(.*)$`, 'm'))
  return m ? m[1].trim().replace(/^"|"$/g, '') : ''
}
const pid = getVar('MICROPAY_PID')
const privateKey = getVar('MICROPAY_PRIVATE_KEY')
const publicKey = getVar('MICROPAY_PUBLIC_KEY')

// 与 SDK/micropay.ts 相同的拼串与签名
function pemToRaw(pem) {
  return pem.replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+KEY-----/, '')
    .replace(/-----END [A-Z ]+KEY-----/, '')
    .replace(/\s+/g, '')
}
function toU8(s) {
  const bin = atob(s)
  const b = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i)
  return b
}
function b64(b) {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
function buildSignStr(params) {
  return Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type')
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&')
}
async function signRSA(str, raw) {
  const pem = raw.includes('-----') ? raw : `-----BEGIN PRIVATE KEY-----\n${pemToRaw(raw)}\n-----END PRIVATE KEY-----`
  const key = await crypto.subtle.importKey('pkcs8', toU8(pemToRaw(pem)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  return b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(str))))
}
async function verifyRSA(str, sign, raw) {
  try {
    const pem = raw.includes('-----') ? raw : `-----BEGIN PUBLIC KEY-----\n${pemToRaw(raw)}\n-----END PUBLIC KEY-----`
    const key = await crypto.subtle.importKey('spki', toU8(pemToRaw(pem)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, toU8(sign), new TextEncoder().encode(str))
  } catch {
    return false
  }
}

// SDK 的 verify():签名前剔除 sign/sign_type/空值;timestamp 需在 ±300 秒内
const params = { pid, out_trade_no: outTradeNo, timestamp: String(Math.floor(Date.now() / 1000)) }
params.sign = await signRSA(buildSignStr(params), privateKey)
params.sign_type = 'RSA'

console.log('查询参数:', JSON.stringify({ ...params, sign: params.sign.slice(0, 20) + '…' }))
const res = await fetch('https://pay.microgg.cn/api/pay/query', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params)
})
const text = await res.text()
console.log('HTTP', res.status, '响应:', text.slice(0, 2000))

// 若返回带签名,用平台公钥验签(rest 含 sign_type,buildSignStr 会剔除 sign/sign_type)
try {
  const data = JSON.parse(text)
  if (data?.sign) {
    const { sign, ...rest } = data
    const ok = await verifyRSA(buildSignStr(rest), sign, publicKey)
    console.log('\n平台公钥验签网关返回:', ok ? '✅ 通过' : '❌ 失败')
  }
} catch {
  /* 非 JSON,忽略 */
}
