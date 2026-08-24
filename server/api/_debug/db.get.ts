// 临时调试端点(验证用,验证后删除):逐步复现 authz 回退逻辑
import { getD1Binding } from '../../utils/d1'
import { getAuthConfig } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const out: Record<string, unknown> = { step: 'start' }
  try {
    const raw = (event.headers.get('cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1]
    out.step = 'cookie'
    out.cookie = raw ? 'yes' : 'no'
    if (!raw) return out
    const dot = raw.lastIndexOf('.')
    out.step = 'parse'
    if (dot <= 0) return out
    const token = raw.slice(0, dot)
    const sigSent = decodeURIComponent(raw.slice(dot + 1))
    out.tokenHead = token.slice(0, 10)
    out.sigHead = sigSent.slice(0, 10)
    const secret = getAuthConfig(event).secret
    out.step = 'secret'
    if (!secret || !sigSent) return out
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token))
    let bin = ''
    for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
    const sigCalc = btoa(bin)
    out.step = 'verify'
    out.sigMatch = sigCalc === sigSent
    if (sigCalc !== sigSent) return out
    const d1 = getD1Binding(event)
    out.step = 'query-session'
    const row = await d1.prepare('SELECT user_id FROM session WHERE token = ? AND expires_at > ?')
      .bind(token, Date.now()).first()
    out.sessionRow = row ? 'found' : 'null'
    if (!row) return out
    out.step = 'query-user'
    const u = await d1.prepare('SELECT id, name, email, email_verified, image FROM user WHERE id = ?')
      .bind(row.user_id).first()
    out.user = u ? 'found' : 'null'
  } catch (e) {
    out.error = String(e)
  }
  return out
})