// server/api/admin/mail/index.get.ts
// 管理后台站内邮件发送历史(分页,按时间倒序;含收件人/主题/状态/错误)。
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { mailSent } from '../../../db/schema'
import { desc, count } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const query = getQuery<{ page?: string, pageSize?: string }>(event)
  const page = Math.max(1, Math.floor(Number(query.page ?? 1)) || 1)
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize ?? 20)) || 20))

  const total = await db.select({ n: count() }).from(mailSent).all()
  const rows = await db.select()
    .from(mailSent)
    .orderBy(desc(mailSent.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  return {
    rows: rows.map(r => ({
      id: r.id,
      recipientEmail: r.recipientEmail,
      recipientName: r.recipientName,
      subject: r.subject,
      content: r.content,
      status: r.status,
      error: r.error,
      createdAt: Number(r.createdAt)
    })),
    total: total[0]?.n ?? 0,
    page,
    pageSize
  }
})
