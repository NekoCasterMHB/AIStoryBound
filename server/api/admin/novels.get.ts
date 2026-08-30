// server/api/admin/novels.get.ts
// 小说审核列表(管理端):每个商品以「最新提交版本」为粒度展示(书名/状态/预览字数/时间),
// 支持按最新版本状态筛选;默认待审核在前、待审核中免费(price=0)更优先,其余按最新提交时间倒序。
import { useD1 } from '../../utils/d1'
import { requireAdmin } from '../../utils/authz'
import { novelProducts, novelProductVersions, user as usersTable } from '../../db/schema'
import { eq, desc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const query = getQuery<{ status?: string }>(event)

  const status = (query.status ?? '').trim() || undefined
  const where = status ? sql`${novelProductVersions.status} = ${status}` : undefined

  // 每个商品 join 最新提交版本(审核与预览均以最新版本为准)
  const rows = await db.select({
    id: novelProducts.id,
    version: novelProductVersions.version,
    title: novelProductVersions.title,
    author: novelProductVersions.author,
    desc: novelProductVersions.desc,
    price: novelProductVersions.price,
    previewChars: novelProductVersions.previewChars,
    totalChars: novelProductVersions.totalChars,
    status: novelProductVersions.status,
    rejectReason: novelProductVersions.rejectReason,
    featured: novelProducts.featured,
    downloadCount: novelProducts.downloadCount,
    purchaseCount: novelProducts.purchaseCount,
    fileSize: novelProductVersions.fileSize,
    sourceEncoding: novelProductVersions.sourceEncoding,
    sellerId: novelProducts.sellerId,
    sellerName: usersTable.name,
    sellerEmail: usersTable.email,
    createdAt: novelProductVersions.createdAt,
    reviewedAt: novelProductVersions.reviewedAt
  })
    .from(novelProducts)
    .innerJoin(
      novelProductVersions,
      sql`${novelProductVersions.id} = (SELECT id FROM novel_product_versions WHERE novel_id = ${novelProducts.id} ORDER BY version DESC LIMIT 1)`
    )
    .leftJoin(usersTable, eq(usersTable.id, novelProducts.sellerId))
    .where(where)
    .orderBy(
      sql`CASE
        WHEN ${novelProductVersions.status} = 'pending' AND ${novelProductVersions.price} = 0 THEN 0
        WHEN ${novelProductVersions.status} = 'pending' THEN 1
        ELSE 2
      END`,
      desc(novelProductVersions.createdAt)
    )
    .all()

  return rows.map(r => ({
    id: r.id,
    version: r.version,
    title: r.title,
    author: r.author,
    desc: r.desc,
    price: r.price,
    previewChars: r.previewChars,
    totalChars: r.totalChars,
    status: r.status,
    rejectReason: r.rejectReason,
    featured: r.featured,
    downloadCount: r.downloadCount,
    purchaseCount: r.purchaseCount,
    fileSize: r.fileSize,
    sourceEncoding: r.sourceEncoding,
    sellerName: r.sellerName ?? '未知用户',
    sellerEmail: r.sellerEmail ?? '',
    createdAt: Number(r.createdAt),
    reviewedAt: r.reviewedAt ? Number(r.reviewedAt) : null
  }))
})
