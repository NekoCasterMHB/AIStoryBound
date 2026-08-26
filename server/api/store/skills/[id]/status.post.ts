// server/api/store/skills/[id]/status.post.ts
// 发布者管理商品上下架(仅限本人商品):
// - status=removed 下架:仅已上架(approved)商品可下架,下架后从商城隐藏,已购者仍可下载既有版本;
// - status=pending  重新上架:仅已下架商品可提交,进入待审核,管理员审核通过后恢复在商城展示。
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { skillProducts } from '../../../../db/schema'
import { and, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 Skill id' })

  const body = await readBody<{ status?: string }>(event).catch(() => null)
  const status = body?.status
  if (status !== 'removed' && status !== 'pending') {
    throw createError({ statusCode: 400, statusMessage: '不支持的操作' })
  }

  const rows = await db.select({ id: skillProducts.id, status: skillProducts.status })
    .from(skillProducts)
    .where(and(eq(skillProducts.id, id), eq(skillProducts.sellerId, user.id)))
    .all()
  const row = rows[0]
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Skill 不存在或不属于你' })
  }
  if (status === 'removed' && row.status !== 'approved') {
    throw createError({ statusCode: 400, statusMessage: '仅已上架的商品可以下架' })
  }
  if (status === 'pending' && row.status !== 'removed') {
    throw createError({ statusCode: 400, statusMessage: '仅已下架的商品可以重新上架' })
  }

  await db.update(skillProducts)
    .set({ status, rejectReason: null, updatedAt: new Date() })
    .where(eq(skillProducts.id, id))
    .run()

  return { ok: true, status }
})
