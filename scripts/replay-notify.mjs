// scripts/replay-notify.mjs — 用网关查询接口返回的真实签名数据,重放为 GET 回调打到 notify,
// 端到端验证生产回调链路(签名方=网关,与真实回调等价)。
// 用法: node scripts/replay-notify.mjs <out_trade_no> <notifyUrl>
import { readFileSync } from 'node:fs'

const [, , outTradeNo, notifyUrl] = process.argv
if (!outTradeNo || !notifyUrl) { console.error('用法: node scripts/replay-notify.mjs <out_trade_no> <notifyUrl>'); process.exit(1) }

const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
function getVar(k) { const m = vars.match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim().replace(/^"|"$/g, '') : '' }
const pid = getVar('MICROPAY_PID')
const privateKey = getVar('MICROPAY_PRIVATE_KEY')

function pemToRaw(pem) { return pem.replace(/\\n/g, '\n').replace(/-----BEGIN [A-Z ]+KEY-----/, '').replace(/-----END [A-Z ]+KEY-----/, '').replace(/\s+/g, '') }
function toU8(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b }
function b64(b) { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
function buildSignStr(params) { return Object.keys(params).filter(k => k !== 'sign' && k !== 'sign_type').filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '').sort().map(k => `${k}=${params[k]}`).join('&') }
async function signRSA(str, raw) {
  const pem = raw.includes('-----') ? raw : `-----BEGIN PRIVATE KEY-----\n${pemToRaw(raw)}\n-----END PRIVATE KEY-----`
  const key = await crypto.subtle.importKey('pkcs8', toU8(pemToRaw(pem)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  return b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(str))))
}

// 1) 查询网关订单,拿网关签名数据
const q = { pid, out_trade_no: outTradeNo, timestamp: String(Math.floor(Date.now() / 1000)) }
q.sign = await signRSA(buildSignStr(q), privateKey)
q.sign_type = 'RSA'
const queryRes = await fetch('https://pay.microgg.cn/api/pay/query', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(q)
})
const gw = JSON.parse(await queryRes.text())
if (gw.code !== 0) { console.log('查询失败:', gw); process.exit(1) }
console.log('网关订单:', gw.trade_no, 'status:', gw.status, 'sign 前 20 位:', gw.sign.slice(0, 20))

// 2) 网关返回的字段 + sign 原样重放为 GET 回调(字段集合与签名绑定一致,验签必然通过)
const { sign_type: _st, ...rest } = gw // sign_type 不含在签名内,但作为查询参数传给 notify 无妨?——不,剔除以免影响字段集合
const params = { ...rest }
delete params.sign_type
const url = new URL(notifyUrl)
for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

console.log('\n=== 重放 GET 回调 ===')
const res = await fetch(url, { method: 'GET' })
console.log('HTTP', res.status, 'body:', JSON.stringify(await res.text()))
