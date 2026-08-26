// server/api/admin/requests/[id]/delete.post.ts
// 管理端:删除需求(点赞记录随外键级联清除)。
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { featureRequests } from '../../../../db/schema'
import { eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id || id.length > 64) {
    throw createError({ statusCode: 400, statusMessage: '参数不合法' })
  }

  const db = useD1(event)
  const res = await db.delete(featureRequests).where(eq(featureRequests.id, id))
  if ((res as unknown as { meta: { changes: number } }).meta.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: '需求不存在' })
  }

  return { ok: true }
})