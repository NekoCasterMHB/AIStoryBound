// server/api/admin/requests/[id]/status.post.ts
// 管理端:变更需求实现状态(open=待实现 | in_progress=开发中 | done=已实现)。
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { featureRequests } from '../../../../db/schema'
import { eq } from 'drizzle-orm'
import { DEMAND_STATUS_LABELS } from '../../../../../shared/demand'

const VALID_STATUSES = Object.keys(DEMAND_STATUS_LABELS) as (keyof typeof DEMAND_STATUS_LABELS)[]

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<{ status?: string }>(event).catch(() => null)

  const status = body?.status
  if (!id || !status || !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    throw createError({ statusCode: 400, statusMessage: '状态不合法' })
  }

  const db = useD1(event)
  const res = await db.update(featureRequests)
    .set({ status: status as typeof VALID_STATUSES[number], updatedAt: new Date() })
    .where(eq(featureRequests.id, id))
  if ((res as unknown as { meta: { changes: number } }).meta.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: '需求不存在' })
  }

  return { ok: true }
})