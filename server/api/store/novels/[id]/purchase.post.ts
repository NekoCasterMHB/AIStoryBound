// server/api/store/novels/[id]/purchase.post.ts
// 购买小说:校验商品已上架且非自购 → 条件扣买家 token(余额不足整批回滚)→
// 写入购买记录(永久可下载)并在同一事务插入 earnings(pending):卖家 80% 分成不再直接入账,
// 由卖家在个人中心「收益」领取后才进入 ai_token_balance;20% 平台手续费记入购买快照。
// 唯一索引(novel_id, buyer_id)兜底:重复购买幂等返回 alreadyOwned。
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { novelProducts, novelProductVersions, novelPurchases, user as usersTable, earnings } from '../../../../db/schema'
import { and, eq, desc, sql } from 'drizzle-orm'
import { uuid } from '../../../../../shared/novel'
import { splitNovelPrice } from '../../../../../shared/store-novel'

export default defineEventHandler(async (event) => {
  const buyer = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少小说 id' })

  const rows = await db.select().from(novelProducts).where(eq(novelProducts.id, id)).all()
  const novel = rows[0]
  if (!novel || novel.status !== 'approved') {
    throw createError({ statusCode: 404, statusMessage: '小说不存在或尚未上架' })
  }
  if (novel.sellerId === buyer.id) {
    throw createError({ statusCode: 400, statusMessage: '不能购买自己发布的小说' })
  }

  // 购买锁定的版本 = 当前在售版本(最新已上架且启用;审核通过前旧版本继续售卖)
  const saleRows = await db.select({ id: novelProductVersions.id })
    .from(novelProductVersions)
    .where(and(
      eq(novelProductVersions.novelId, id),
      eq(novelProductVersions.status, 'approved'),
      eq(novelProductVersions.enabled, 1)
    ))
    .orderBy(desc(novelProductVersions.version))
    .limit(1)
    .all()
  const saleVersion = saleRows[0]
  if (!saleVersion) {
    throw createError({ statusCode: 409, statusMessage: '该小说暂无可售版本' })
  }

  // 幂等:已购买过则直接返回(一次购买,永久可下载)
  const existing = await db.select({ id: novelPurchases.id })
    .from(novelPurchases)
    .where(and(eq(novelPurchases.novelId, id), eq(novelPurchases.buyerId, buyer.id)))
    .all()
  if (existing.length > 0) {
    return { ok: true, alreadyOwned: true, price: novel.price }
  }

  const { sellerShare, platformFee } = splitNovelPrice(novel.price)
  const now = new Date()
  // 余额预检(常见路径提前拦下,避免 batch 已提交后才判定不足的旧缺陷;并发兜底由下方条件扣款 + changes 校验承担)
  const buyerRows = await db.select({ balance: usersTable.aiTokenBalance })
    .from(usersTable)
    .where(eq(usersTable.id, buyer.id))
    .all()
  if ((buyerRows[0]?.balance ?? 0) < novel.price) {
    throw createError({ statusCode: 402, statusMessage: 'token 余额不足,请到个人中心充值或兑换' })
  }

  // 原子结算:买家条件扣款(0 行 = 并发下余额不足,整批回滚)。
  // 卖家分成不再直接入账:同一事务插入 earnings(pending),卖家在个人中心领取后才入 ai_token_balance。
  const purchaseId = uuid()
  const results = await db.batch([
    db.update(usersTable)
      .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${novel.price}` })
      .where(and(
        eq(usersTable.id, buyer.id),
        sql`${usersTable.aiTokenBalance} >= ${novel.price}`
      )),
    db.update(novelProducts)
      .set({ purchaseCount: sql`${novelProducts.purchaseCount} + 1`, updatedAt: now })
      .where(eq(novelProducts.id, id)),
    db.insert(novelPurchases).values({
      id: purchaseId,
      novelId: id,
      buyerId: buyer.id,
      price: novel.price,
      sellerShare,
      platformFee,
      novelVersionId: saleVersion.id,
      createdAt: now
    }),
    db.insert(earnings).values({
      id: uuid(),
      userId: novel.sellerId,
      amount: sellerShare,
      sourceType: 'novel_sale',
      sourceId: purchaseId,
      itemTitle: `《${novel.title}》销售分成`,
      reason: null,
      status: 'pending',
      createdAt: now,
      claimedAt: null
    })
  ])
  const deductChanges = (results[0] as { meta: { changes: number } }).meta.changes
  if (deductChanges === 0) {
    throw createError({ statusCode: 402, statusMessage: 'token 余额不足,请到个人中心充值或兑换' })
  }

  return { ok: true, price: novel.price, sellerShare, platformFee }
})
