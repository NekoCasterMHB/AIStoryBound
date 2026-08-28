// server/api/admin/announcements/index.post.ts
// 管理员新建公告(标题 / markdown 内容 / 是否立即发布)。
import { normalizeAnnouncementInput, newAnnouncementId } from '../../../../shared/announcement'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { announcements } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody<{ title?: unknown, content?: unknown, published?: unknown }>(event).catch(() => null)
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: '参数错误' })
  }

  let input
  try {
    input = normalizeAnnouncementInput(body.title, body.content, body.published)
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: e instanceof Error ? e.message : '参数错误' })
  }

  const now = new Date()
  await useD1(event).insert(announcements).values({
    id: newAnnouncementId(),
    title: input.title,
    content: input.content,
    published: input.published ? 1 : 0,
    createdAt: now,
    updatedAt: now
  }).run()

  return { ok: true }
})
