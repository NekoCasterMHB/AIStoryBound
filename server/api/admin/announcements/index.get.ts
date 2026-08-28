// server/api/admin/announcements/index.get.ts
// 管理员查看公告列表(含草稿/下线),按创建时间倒序。
import { desc } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { announcements } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const rows = await useD1(event).select()
    .from(announcements)
    .orderBy(desc(announcements.createdAt))
    .all()

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content,
    published: r.published === 1,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime()
  }))
})
