// server/api/demand/index.get.ts
// 需求墙列表(公开):已实现的排后、其余按点赞数降序(高赞优先实现),同日期的先提出在前;
// 登录用户附带 liked 标记(是否已点赞,便于前端高亮)。
import { useD1 } from '../../utils/d1'
import { getSessionUser } from '../../utils/authz'
import { featureRequests, featureRequestLikes, user as usersTable } from '../../db/schema'
import { eq, desc, asc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const db = useD1(event)

  const rows = await db.select({
    id: featureRequests.id,
    title: featureRequests.title,
    desc: featureRequests.desc,
    likeCount: featureRequests.likeCount,
    status: featureRequests.status,
    authorName: usersTable.name,
    createdAt: featureRequests.createdAt
  })
    .from(featureRequests)
    .leftJoin(usersTable, eq(usersTable.id, featureRequests.userId))
    .orderBy(
      sql`CASE WHEN ${featureRequests.status} = 'done' THEN 1 ELSE 0 END`,
      desc(featureRequests.likeCount),
      asc(featureRequests.createdAt)
    )
    .all()

  // 已登录时查询其点赞集(未登录置全部 false)
  const sessionUser = await getSessionUser(event)
  const likedIds = new Set<string>()
  if (sessionUser) {
    const likes = await db.select({ requestId: featureRequestLikes.requestId })
      .from(featureRequestLikes)
      .where(eq(featureRequestLikes.userId, sessionUser.id))
      .all()
    for (const l of likes) likedIds.add(l.requestId)
  }

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    desc: r.desc,
    likeCount: r.likeCount,
    status: r.status,
    liked: likedIds.has(r.id),
    authorName: r.authorName ?? '未知用户',
    createdAt: Number(r.createdAt)
  }))
})