// server/api/store/plugins.get.ts
// 功能插件商城列表(公开):仅返回已上架(approved),免费(price=0)优先、推荐在前、新品在后;
// 登录用户附带 owned 标记(是否已购买,便于前端切换"购买/已解锁"按钮)。
import { useD1 } from '../../utils/d1'
import { getSessionUser } from '../../utils/authz'
import { pluginProducts, pluginPurchases } from '../../db/schema'
import { eq, desc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const db = useD1(event)
  const session = await getSessionUser(event)

  const rows = await db.select({
    id: pluginProducts.id,
    name: pluginProducts.name,
    desc: pluginProducts.desc,
    price: pluginProducts.price,
    icon: pluginProducts.icon,
    featured: pluginProducts.featured,
    purchaseCount: pluginProducts.purchaseCount,
    createdAt: pluginProducts.createdAt
  })
    .from(pluginProducts)
    .where(eq(pluginProducts.status, 'approved'))
    .orderBy(
      // 免费优先、推荐在前、新品在后
      desc(sql`(${pluginProducts.price} = 0)`),
      desc(pluginProducts.featured),
      desc(pluginProducts.createdAt)
    )
    .all()

  // 登录用户批量取 owned
  let ownedIds = new Set<string>()
  if (session) {
    const buys = await db.select({ pluginId: pluginPurchases.pluginId })
      .from(pluginPurchases)
      .where(eq(pluginPurchases.buyerId, session.id))
      .all()
    ownedIds = new Set(buys.map(b => b.pluginId))
  }

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    desc: r.desc,
    price: r.price,
    icon: r.icon,
    featured: r.featured,
    purchaseCount: r.purchaseCount,
    createdAt: r.createdAt,
    owned: ownedIds.has(r.id)
  }))
})
