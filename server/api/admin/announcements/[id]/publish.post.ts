// server/api/admin/announcements/[id]/publish.post.ts
// 管理员切换公告展示/隐藏(published 0|1):列表内开关直切,不改标题/内容;不存在返回 404。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { announcements } from '../../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<{ published?: unknown }>(event).catch(() => null)
  if (!id || body === null || typeof body.published !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: '参数错误:published 必须为布尔值' })
  }

  const db = useD1(event)
  const res = await db.update(announcements)
    .set({
      published: body.published ? 1 : 0,
      updatedAt: new Date()
    })
    .where(eq(announcements.id, id))
    .run()
  if (res.meta.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: '公告不存在' })
  }

  return { ok: true, published: body.published }
})
