// server/api/store/skills/[id]/price.post.ts
// 修改售价(仅限本人 Skill):只更新商品主表 price,不影响已购者(购买时权益已锁定),
// 不涉及退款,仅影响之后的购买。版本快照价格不动(历史版本价格保持可追溯)。
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { skillProducts } from '../../../../db/schema'
import { and, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 Skill id' })

  const body = await readBody<{ price?: unknown }>(event).catch(() => null)
  const price = Math.floor(Number(body?.price))
  if (!Number.isFinite(price) || price < 0) {
    throw createError({ statusCode: 400, statusMessage: '售价需为不小于 0 的整数 token(0 表示免费)' })
  }

  const rows = await db.select({ id: skillProducts.id, price: skillProducts.price })
    .from(skillProducts)
    .where(and(eq(skillProducts.id, id), eq(skillProducts.sellerId, user.id)))
    .all()
  const product = rows[0]
  if (!product) {
    throw createError({ statusCode: 404, statusMessage: 'Skill 不存在或不属于你' })
  }
  if (product.price === price) {
    return { ok: true, price, unchanged: true }
  }

  await db.update(skillProducts)
    .set({ price, updatedAt: new Date() })
    .where(eq(skillProducts.id, id))
    .run()

  return { ok: true, price }
})
