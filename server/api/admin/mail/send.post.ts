// server/api/admin/mail/send.post.ts
// 管理后台站内邮件发送:选择注册用户为收件人,通过 Cloudflare Email Service 发送真实邮件,
// 逐封落 mail_sent 表(成功/失败均可追溯);一封失败不影响其余,返回逐封结果。
import { inArray } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { mailSent, user as usersTable } from '../../../db/schema'
import { sendEmail, getEmailCtx } from '../../../utils/email'
import { uuid } from '../../../../shared/novel'

const MAX_SUBJECT_CHARS = 200
const MAX_CONTENT_CHARS = 10_000
const MAX_RECIPIENTS = 200

/** 简单 HTML 转义(邮件正文按纯文本安全注入,防管理员输入破坏模板) */
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'
  })[c]!)
}

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = await readBody<{ recipientIds?: unknown, subject?: unknown, content?: unknown }>(event).catch(() => null)
  if (body === null) throw createError({ statusCode: 400, statusMessage: '参数错误' })

  const recipientIds = Array.isArray(body.recipientIds)
    ? body.recipientIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, MAX_RECIPIENTS)
    : []
  const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, MAX_SUBJECT_CHARS) : ''
  const content = typeof body.content === 'string' ? body.content.trim().slice(0, MAX_CONTENT_CHARS) : ''
  if (recipientIds.length === 0) throw createError({ statusCode: 400, statusMessage: '请至少选择一位收件人' })
  if (!subject) throw createError({ statusCode: 400, statusMessage: '邮件主题不能为空' })
  if (!content) throw createError({ statusCode: 400, statusMessage: '邮件内容不能为空' })

  const db = useD1(event)
  const senderId = admin.id

  // 按 id 批量取收件人邮箱/昵称(缺失 id 跳过,不报错)
  const recipients = await db.select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
    .from(usersTable)
    .where(inArray(usersTable.id, recipientIds))
    .all()

  const html = `
    <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1f2937;">AI Word2World</h2>
      <p style="color: #374151; white-space: pre-line;">${escHtml(content)}</p>
      <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">本邮件由 AI Word2World 官方发送,请勿直接回复。</p>
    </div>`

  const now = new Date()
  const results: { email: string, ok: boolean, error?: string }[] = []
  let sent = 0
  let failed = 0
  const emailCtx = getEmailCtx(event)

  for (const r of recipients) {
    const email = r.email?.trim()
    if (!email) {
      results.push({ email: r.email ?? '', ok: false, error: '该用户未绑定邮箱' })
      failed++
      continue
    }
    try {
      await sendEmail({
        to: email,
        subject: `【AI Word2World】${subject}`,
        html,
        text: content,
        ctx: emailCtx
      })
      sent++
      results.push({ email, ok: true })
      await db.insert(mailSent).values({
        id: uuid(),
        senderId,
        recipientId: r.id,
        recipientEmail: email,
        recipientName: r.name ?? undefined,
        subject,
        content,
        status: 'sent',
        createdAt: now
      }).run()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      failed++
      results.push({ email, ok: false, error: msg })
      await db.insert(mailSent).values({
        id: uuid(),
        senderId,
        recipientId: r.id,
        recipientEmail: email,
        recipientName: r.name ?? undefined,
        subject,
        content,
        status: 'failed',
        error: msg.slice(0, 500),
        createdAt: now
      }).run()
    }
  }

  return { sent, failed, results }
})
