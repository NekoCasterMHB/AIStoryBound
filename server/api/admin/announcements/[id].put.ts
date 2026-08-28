// server/api/admin/announcements/[id].put.ts
// 管理员更新公告(标题 / markdown 内容 / 发布状态);不存在返回 404。
import { eq } from 'drizzle-orm'
import { normalizeAnnouncementInput } from '../../../../shared/announcement'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { announcements } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<{ title?: unknown, content?: unknown, published?: unknown }>(event).catch(() => null)
  if (!id || body === null) {
    throw createError({ statusCode: 400, statusMessage: '参数错误' })
  }

  let input
  try {
    input = normalizeAnnouncementInput(body.title, body.content, body.published)
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: e instanceof Error ? e.message : '参数错误' })
  }

  const db = useD1(event)
  const res = await db.update(announcements)
    .set({
      title: input.title,
      content: input.content,
      published: input.published ? 1 : 0,
      updatedAt: new Date()
    })
    .where(eq(announcements.id, id))
    .run()
  if (res.meta.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: '公告不存在' })
  }

  return { ok: true }
})
