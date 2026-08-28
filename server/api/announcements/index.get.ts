// server/api/announcements/index.get.ts
// 公告列表(公开):仅返回已发布公告,按发布时间倒序(最新在前)。
// 客户端据此与 localStorage 已读游标(announcement-read-until)比对,判断是否需要弹窗。
import { desc, eq } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { announcements } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const rows = await useD1(event).select()
    .from(announcements)
    .where(eq(announcements.published, 1))
    .orderBy(desc(announcements.createdAt))
    .all()

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content,
    published: true,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime()
  }))
})
