// server/api/store/skills.get.ts
// Skill 商城商品列表(公开):仅返回已上架(approved)商品,免费(price=0)优先、推荐在前、新品在后;
// 登录用户附带 owned 标记(是否已购买,便于前端切换"购买/下载"按钮)。
import { useD1 } from '../../utils/d1'
import { getSessionUser } from '../../utils/authz'
import { skillProducts, skillPurchases, user as usersTable } from '../../db/schema'
import { eq, desc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const db = useD1(event)

  const rows = await db.select({
    id: skillProducts.id,
    name: skillProducts.name,
    desc: skillProducts.desc,
    price: skillProducts.price,
    sellerName: usersTable.name,
    featured: skillProducts.featured,
    downloadCount: skillProducts.downloadCount,
    purchaseCount: skillProducts.purchaseCount,
    createdAt: skillProducts.createdAt
  })
    .from(skillProducts)
    .leftJoin(usersTable, eq(usersTable.id, skillProducts.sellerId))
    .where(eq(skillProducts.status, 'approved'))
    .orderBy(
      sql`CASE WHEN ${skillProducts.price} = 0 THEN 0 ELSE 1 END`,
      desc(skillProducts.featured),
      desc(skillProducts.createdAt)
    )
    .all()

  // 已登录时查询其购买集(未登录置全部 false)
  const sessionUser = await getSessionUser(event)
  const ownedIds = new Set<string>()
  if (sessionUser) {
    const owned = await db.select({ skillId: skillPurchases.skillId })
      .from(skillPurchases)
      .where(eq(skillPurchases.buyerId, sessionUser.id))
      .all()
    for (const o of owned) ownedIds.add(o.skillId)
  }

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    desc: r.desc,
    price: r.price,
    sellerName: r.sellerName ?? '未知用户',
    featured: r.featured,
    downloadCount: r.downloadCount,
    purchaseCount: r.purchaseCount,
    createdAt: Number(r.createdAt),
    owned: ownedIds.has(r.id)
  }))
})