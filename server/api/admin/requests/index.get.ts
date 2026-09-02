// server/api/admin/requests/index.get.ts
// 需求墙列表(管理端):排序与公开 /api/demand 一致(已实现排后、高赞优先、同日先提出在前),
// 额外返回发起人邮箱——公开接口出于隐私不含邮箱,管理端需要用它定位/联系发起人。
import { useD1 } from '../../../utils/d1'
import { requireAdmin } from '../../../utils/authz'
import { featureRequests, user as usersTable } from '../../../db/schema'
import { eq, desc, asc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)

  const rows = await db.select({
    id: featureRequests.id,
    title: featureRequests.title,
    desc: featureRequests.desc,
    likeCount: featureRequests.likeCount,
    status: featureRequests.status,
    authorName: usersTable.name,
    authorEmail: usersTable.email,
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

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    desc: r.desc,
    likeCount: r.likeCount,
    status: r.status,
    liked: false,
    authorName: r.authorName ?? '未知用户',
    authorEmail: r.authorEmail ?? null,
    createdAt: Number(r.createdAt)
  }))
})
