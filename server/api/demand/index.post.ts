// server/api/demand/index.post.ts
// 发起新需求(需登录):标题+描述校验后写入,发起人自动点赞(like_count 从 1 起,
// 避免新需求垫底)。返回创建后的完整条目,前端插入列表。
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { featureRequests, featureRequestLikes } from '../../db/schema'
import { normalizeDemandInput, newDemandId, type DemandItem } from '../../../shared/demand'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ title?: string, desc?: string }>(event).catch(() => null)

  let normalized: { title: string, desc: string }
  try {
    normalized = normalizeDemandInput(body?.title ?? '', body?.desc ?? '')
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: e instanceof Error ? e.message : '输入不合法' })
  }

  const db = useD1(event)
  const id = newDemandId()
  const now = new Date()

  // 需求 + 发起人自赞同批写入,任一步失败整体回滚
  await db.batch([
    db.insert(featureRequests).values({ id, userId: user.id, title: normalized.title, desc: normalized.desc, likeCount: 1, status: 'open', createdAt: now, updatedAt: now }),
    db.insert(featureRequestLikes).values({ id: newDemandId(), requestId: id, userId: user.id, createdAt: now })
  ])

  const item: DemandItem = { id, title: normalized.title, desc: normalized.desc, likeCount: 1, status: 'open', liked: true, authorName: user.name ?? '', createdAt: now.getTime() }
  return item
})
