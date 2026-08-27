// server/api/store/novels.get.ts
// 小说商城列表(公开,创意工坊「书架」):仅返回已上架(approved)且至少有一个已上架版本的商品,
// 免费(price=0)优先、推荐在前、新品在后;登录用户附带 owned 标记(是否已购买/是否自己发布)。
import { useD1 } from '../../utils/d1'
import { getSessionUser } from '../../utils/authz'
import { novelProducts, novelProductVersions, novelPurchases, user as usersTable } from '../../db/schema'
import { and, eq, desc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const db = useD1(event)

  const rows = await db.select({
    id: novelProducts.id,
    title: novelProducts.title,
    author: novelProducts.author,
    desc: novelProducts.desc,
    price: novelProducts.price,
    previewChars: novelProducts.previewChars,
    totalChars: novelProducts.totalChars,
    sellerName: usersTable.name,
    featured: novelProducts.featured,
    downloadCount: novelProducts.downloadCount,
    purchaseCount: novelProducts.purchaseCount,
    sellerId: novelProducts.sellerId,
    createdAt: novelProducts.createdAt,
    mainVersion: novelProducts.mainVersion
  })
    .from(novelProducts)
    .leftJoin(usersTable, eq(usersTable.id, novelProducts.sellerId))
    .where(eq(novelProducts.status, 'approved'))
    .orderBy(
      sql`CASE WHEN ${novelProducts.price} = 0 THEN 0 ELSE 1 END`,
      desc(novelProducts.featured),
      desc(novelProducts.createdAt)
    )
    .all()

  // 各商品已上架且启用的版本(「获取」版本切换;禁用的版本用户侧不显示)
  const verRows = await db.select({
    novelId: novelProductVersions.novelId,
    version: novelProductVersions.version,
    createdAt: novelProductVersions.createdAt
  })
    .from(novelProductVersions)
    .where(and(eq(novelProductVersions.status, 'approved'), eq(novelProductVersions.enabled, 1)))
    .orderBy(desc(novelProductVersions.version))
    .all()
  const versionsByNovel = new Map<string, { version: number, createdAt: number }[]>()
  for (const v of verRows) {
    const list = versionsByNovel.get(v.novelId) ?? []
    list.push({ version: v.version, createdAt: Number(v.createdAt) })
    versionsByNovel.set(v.novelId, list)
  }

  // 已登录时查询其购买集+自己发布的商品(未登录置全部 false)
  const sessionUser = await getSessionUser(event)
  const ownedIds = new Set<string>()
  const purchasedIds = new Set<string>()
  if (sessionUser) {
    const owned = await db.select({ novelId: novelPurchases.novelId })
      .from(novelPurchases)
      .where(eq(novelPurchases.buyerId, sessionUser.id))
      .all()
    for (const o of owned) {
      purchasedIds.add(o.novelId)
      ownedIds.add(o.novelId)
    }
    // 自己是发布者的商品等同拥有(前端显示"下载"而非"购买/免费获取",避免自购 400)
    for (const r of rows) {
      if (r.sellerId === sessionUser.id) ownedIds.add(r.id)
    }
  }

  return rows
    // 防御:商品状态 approved 但没有任何已上架版本(历史脏数据)时不在商城展示
    .filter(r => (versionsByNovel.get(r.id)?.length ?? 0) > 0)
    .map(r => ({
      id: r.id,
      title: r.title,
      author: r.author,
      desc: r.desc,
      price: r.price,
      previewChars: r.previewChars,
      totalChars: r.totalChars,
      sellerName: r.sellerName ?? '未知用户',
      featured: r.featured,
      downloadCount: r.downloadCount,
      purchaseCount: r.purchaseCount,
      createdAt: Number(r.createdAt),
      owned: ownedIds.has(r.id),
      purchased: purchasedIds.has(r.id),
      versions: versionsByNovel.get(r.id) ?? [],
      mainVersion: r.mainVersion
    }))
})
