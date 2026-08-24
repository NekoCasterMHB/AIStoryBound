// server/utils/email.ts
// 验证码邮件发送:Cloudflare Email Service — Email Sending REST API(无需 Worker binding)。
// 端点:POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send
// 鉴权:Authorization: Bearer <CF_API_TOKEN_SEND_EMAIL>(需 Email Sending: Edit 权限的 API token)
// 前置:发件域名需在 Cloudflare 控制台 onboard 到 Email Service(Email Sending 公开测试版,需 Workers Paid 计划),
//       发件人地址(EMAIL_FROM)必须属于该域名。
// 未配置 accountId/token/发件人(如本地未配 .dev.vars)→ 降级:验证码打印到服务器日志,注册/登录流程仍可完整跑通。
import type { H3Event } from 'h3'

export type OtpType = 'sign-in' | 'email-verification' | 'forget-password'

export interface EmailCtx {
  /** Cloudflare 账号 ID(非敏感,可放 wrangler vars) */
  CLOUDFLARE_ACCOUNT_ID?: string
  /** 发信 API token(敏感,生产用 wrangler secret put CF_API_TOKEN_SEND_EMAIL) */
  CF_API_TOKEN_SEND_EMAIL?: string
  /** 发件人地址,必须属于已 onboard 到 Email Service 的域名 */
  EMAIL_FROM?: string
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

/** 从事件上下文取邮件配置(env 优先,runtimeConfig.email 兜底) */
export function getEmailCtx(event?: H3Event): EmailCtx {
  const env = event
    ? (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env
    : undefined
  const rt = event ? (useRuntimeConfig(event).email as { from?: string, accountId?: string, token?: string } | undefined) : undefined
  return {
    CLOUDFLARE_ACCOUNT_ID: env?.CLOUDFLARE_ACCOUNT_ID || rt?.accountId || '',
    CF_API_TOKEN_SEND_EMAIL: env?.CF_API_TOKEN_SEND_EMAIL || rt?.token || '',
    EMAIL_FROM: env?.EMAIL_FROM || rt?.from || ''
  }
}

const TYPE_LABEL: Record<OtpType, string> = {
  'sign-in': '登录验证码',
  'email-verification': '注册验证码',
  'forget-password': '重置密码验证码'
}

/** 发送验证码邮件;回调内无 event,直接接收 EmailCtx(见 getAuth 闭包) */
export async function sendOtpEmail(email: string, otp: string, type: OtpType | string, ctx: EmailCtx = {}): Promise<void> {
  const accountId = ctx.CLOUDFLARE_ACCOUNT_ID?.trim()
  const token = ctx.CF_API_TOKEN_SEND_EMAIL?.trim()
  const from = ctx.EMAIL_FROM?.trim()
  if (!accountId || !token || !from) {
    // dev 降级:未配置发信密钥/发件人 → 验证码打印到日志
    console.log(`[email:dev] ${TYPE_LABEL[type as OtpType] ?? type} for ${email}: ${otp}`)
    return
  }
  const label = TYPE_LABEL[type as OtpType] ?? type
  const html = `
    <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1f2937;">AI SpankWorld</h2>
      <p style="color: #374151;">你的${label}是:</p>
      <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #0f172a;">${otp}</p>
      <p style="color: #6b7280; font-size: 13px;">验证码 5 分钟内有效。若非本人操作请忽略本邮件。</p>
    </div>`
  try {
    const res = await fetch(`${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/email/sending/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: email,
        from,
        subject: `【AI SpankWorld】${label}`,
        html,
        text: `你的${label}是: ${otp},5 分钟内有效。若非本人操作请忽略本邮件。`
      })
    })
    const data = await res.json().catch(() => null) as { success?: boolean, errors?: Array<{ code?: number, message?: string }> } | null
    if (!res.ok || !data?.success) {
      const msg = data?.errors?.map(e => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`
      throw new Error(`发送验证码邮件失败: ${msg}`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('发送验证码邮件失败')) throw e
    throw new Error(`发送验证码邮件失败: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
}
