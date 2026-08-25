// server/api/store/skills/[id]/purchase.post.ts
// 购买 Skill:校验商品已上架且非自购 → 条件扣买家 token(余额不足整批回滚)→
// 卖家余额 + 售价*80%(直接入账)、20% 平台手续费记入购买快照 → 写入购买记录(永久可下载)。
// 唯一索引(skill_id, buyer_id)兜底:重复购买幂等返回 alreadyOwned。
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { skillProducts, skillProductVersions, skillPurchases, user as usersTable } from '../../../../db/schema'
import { and, eq, desc, sql } from 'drizzle-orm'
import { uuid } from '../../../../../shared/novel'
import { splitSkillPrice } from '../../../../../shared/store-skill'

export default defineEventHandler(async (event) => {
  const buyer = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 Skill id' })

  const rows = await db.select().from(skillProducts).where(eq(skillProducts.id, id)).all()
  const skill = rows[0]
  if (!skill || skill.status !== 'approved') {
    throw createError({ statusCode: 404, statusMessage: 'Skill 不存在或尚未上架' })
  }
  if (skill.sellerId === buyer.id) {
    throw createError({ statusCode: 400, statusMessage: '不能购买自己发布的 Skill' })
  }

  // 购买锁定的版本 = 当前在售版本(最新已上架;审核通过前旧版本继续售卖)
  const saleRows = await db.select({ id: skillProductVersions.id })
    .from(skillProductVersions)
    .where(and(eq(skillProductVersions.skillId, id), eq(skillProductVersions.status, 'approved')))
    .orderBy(desc(skillProductVersions.version))
    .limit(1)
    .all()
  const saleVersion = saleRows[0]
  if (!saleVersion) {
    throw createError({ statusCode: 409, statusMessage: '该 Skill 暂无可售版本' })
  }

  // 幂等:已购买过则直接返回(一次购买,永久可下载)
  const existing = await db.select({ id: skillPurchases.id })
    .from(skillPurchases)
    .where(and(eq(skillPurchases.skillId, id), eq(skillPurchases.buyerId, buyer.id)))
    .all()
  if (existing.length > 0) {
    return { ok: true, alreadyOwned: true, price: skill.price }
  }

  const { sellerShare, platformFee } = splitSkillPrice(skill.price)
  const now = new Date()

  // 原子结算:买家条件扣款(0 行 = 余额不足,整批回滚,不会出现"扣了款没记录")
  const results = await db.batch([
    db.update(usersTable)
      .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${skill.price}` })
      .where(and(
        eq(usersTable.id, buyer.id),
        sql`${usersTable.aiTokenBalance} >= ${skill.price}`
      )),
    db.update(usersTable)
      .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${sellerShare}` })
      .where(eq(usersTable.id, skill.sellerId)),
    db.update(skillProducts)
      .set({ purchaseCount: sql`${skillProducts.purchaseCount} + 1`, updatedAt: now })
      .where(eq(skillProducts.id, id)),
    db.insert(skillPurchases).values({
      id: uuid(),
      skillId: id,
      buyerId: buyer.id,
      price: skill.price,
      sellerShare,
      platformFee,
      skillVersionId: saleVersion.id,
      createdAt: now
    })
  ])
  const deductChanges = (results[0] as { meta: { changes: number } }).meta.changes
  if (deductChanges === 0) {
    throw createError({ statusCode: 402, statusMessage: 'token 余额不足,请到个人中心充值或兑换' })
  }

  return { ok: true, price: skill.price, sellerShare, platformFee }
})
