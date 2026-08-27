// server/api/demand/[id]/like.post.ts
// 点赞/取消点赞(需登录,toggle):已赞则取消并计数 -1,未赞则点赞并计数 +1;
// 点赞记录与冗余计数同批写入保证原子性。返回最新状态与计数。
import { useD1 } from '../../../utils/d1'
import { requireUserId } from '../../../utils/authz'
import { featureRequests, featureRequestLikes } from '../../../db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { newDemandId } from '../../../../shared/demand'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const id = getRouterParam(event, 'id')
  if (!id || id.length > 64) {
    throw createError({ statusCode: 400, statusMessage: '参数不合法' })
  }

  const db = useD1(event)
  const request = await db.select({ id: featureRequests.id })
    .from(featureRequests)
    .where(eq(featureRequests.id, id))
    .get()
  if (!request) {
    throw createError({ statusCode: 404, statusMessage: '需求不存在' })
  }

  const existing = await db.select({ id: featureRequestLikes.id })
    .from(featureRequestLikes)
    .where(and(eq(featureRequestLikes.requestId, id), eq(featureRequestLikes.userId, userId)))
    .get()

  if (existing) {
    // 取消点赞:删记录 + 计数 -1(与点赞记录一一对应,不会为负)
    await db.batch([
      db.delete(featureRequestLikes).where(eq(featureRequestLikes.id, existing.id)),
      db.update(featureRequests).set({
        likeCount: sql`MAX(${featureRequests.likeCount} - 1, 0)`,
        updatedAt: new Date()
      }).where(eq(featureRequests.id, id))
    ])
  } else {
    // 点赞:插记录 + 计数 +1
    await db.batch([
      db.insert(featureRequestLikes).values({ id: newDemandId(), requestId: id, userId, createdAt: new Date() }),
      db.update(featureRequests).set({
        likeCount: sql`${featureRequests.likeCount} + 1`,
        updatedAt: new Date()
      }).where(eq(featureRequests.id, id))
    ])
  }

  const current = await db.select({ likeCount: featureRequests.likeCount })
    .from(featureRequests)
    .where(eq(featureRequests.id, id))
    .get()

  return { ok: true, liked: !existing, likeCount: current?.likeCount ?? 0 }
})
