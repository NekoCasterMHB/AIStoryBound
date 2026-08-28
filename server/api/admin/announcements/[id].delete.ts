// server/api/admin/announcements/[id].delete.ts
// 管理员删除公告;不存在返回 404。
import { eq } from 'drizzle-orm'
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { announcements } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '参数错误' })
  }

  const db = useD1(event)
  const res = await db.delete(announcements).where(eq(announcements.id, id)).run()
  if (res.meta.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: '公告不存在' })
  }

  return { ok: true }
})
