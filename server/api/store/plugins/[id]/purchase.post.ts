// server/api/store/plugins/[id]/purchase.post.ts
// 购买功能插件:校验商品已上架 → 幂等(已购直接返回 alreadyOwned)→
// 0 价免费直接解锁;>0 价条件扣买家 token(余额不足 402)→ 写入购买记录(永久解锁)。
// 官方商品无卖家分成(平台自营)。
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { pluginProducts, pluginPurchases, user as usersTable } from '../../../../db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { uuid } from '../../../../../shared/novel'

export default defineEventHandler(async (event) => {
  const buyer = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少插件 id' })

  const rows = await db.select().from(pluginProducts).where(eq(pluginProducts.id, id)).all()
  const plugin = rows[0]
  if (!plugin || plugin.status !== 'approved') {
    throw createError({ statusCode: 404, statusMessage: '功能插件不存在或尚未上架' })
  }

  // 幂等:已购买过则直接返回(一次购买,永久解锁)
  const existing = await db.select({ id: pluginPurchases.id })
    .from(pluginPurchases)
    .where(and(eq(pluginPurchases.pluginId, id), eq(pluginPurchases.buyerId, buyer.id)))
    .all()
  if (existing.length > 0) {
    return { ok: true, alreadyOwned: true, price: plugin.price }
  }

  const now = new Date()
  if (plugin.price > 0) {
    // 原子扣款:0 行 = 余额不足,整批回滚,不会出现"扣了款没记录"
    const results = await db.batch([
      db.update(usersTable)
        .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${plugin.price}` })
        .where(and(
          eq(usersTable.id, buyer.id),
          sql`${usersTable.aiTokenBalance} >= ${plugin.price}`
        )),
      db.update(pluginProducts)
        .set({ purchaseCount: sql`${pluginProducts.purchaseCount} + 1`, updatedAt: now })
        .where(eq(pluginProducts.id, id)),
      db.insert(pluginPurchases).values({
        id: uuid(),
        pluginId: id,
        buyerId: buyer.id,
        price: plugin.price,
        createdAt: now
      })
    ])
    const deductChanges = (results[0] as { meta: { changes: number } }).meta.changes
    if (deductChanges === 0) {
      throw createError({ statusCode: 402, statusMessage: 'token 余额不足,请到个人中心充值或兑换' })
    }
  } else {
    // 免费插件:直接解锁(仍记购买记录,个人中心「功能插件」tab 展示)
    await db.batch([
      db.update(pluginProducts)
        .set({ purchaseCount: sql`${pluginProducts.purchaseCount} + 1`, updatedAt: now })
        .where(eq(pluginProducts.id, id)),
      db.insert(pluginPurchases).values({
        id: uuid(),
        pluginId: id,
        buyerId: buyer.id,
        price: 0,
        createdAt: now
      })
    ])
  }

  return { ok: true, price: plugin.price }
})
