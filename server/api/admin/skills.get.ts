// server/api/admin/skills.get.ts
// Skill 审核列表(管理端):每个商品以「最新提交版本」为粒度展示(名称/状态/文件清单/时间),
// 支持按最新版本状态筛选;默认待审核在前、待审核中免费(price=0)更优先,其余按最新提交时间倒序。
import { useD1 } from '../../utils/d1'
import { requireAdmin } from '../../utils/authz'
import { skillProducts, skillProductVersions, user as usersTable } from '../../db/schema'
import { eq, desc, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const query = getQuery<{ status?: string }>(event)

  const status = (query.status ?? '').trim() || undefined
  const where = status ? sql`${skillProductVersions.status} = ${status}` : undefined

  // 每个商品 join 最新提交版本(审核与预览均以最新版本为准)
  const rows = await db.select({
    id: skillProducts.id,
    version: skillProductVersions.version,
    name: skillProductVersions.name,
    desc: skillProductVersions.desc,
    price: skillProductVersions.price,
    status: skillProductVersions.status,
    rejectReason: skillProductVersions.rejectReason,
    featured: skillProducts.featured,
    downloadCount: skillProducts.downloadCount,
    purchaseCount: skillProducts.purchaseCount,
    fileSize: skillProductVersions.fileSize,
    fileEntries: skillProductVersions.fileEntries,
    sellerId: skillProducts.sellerId,
    sellerName: usersTable.name,
    sellerEmail: usersTable.email,
    createdAt: skillProductVersions.createdAt,
    reviewedAt: skillProductVersions.reviewedAt
  })
    .from(skillProducts)
    .innerJoin(
      skillProductVersions,
      sql`${skillProductVersions.id} = (SELECT id FROM skill_product_versions WHERE skill_id = ${skillProducts.id} ORDER BY version DESC LIMIT 1)`
    )
    .leftJoin(usersTable, eq(usersTable.id, skillProducts.sellerId))
    .where(where)
    .orderBy(
      sql`CASE
        WHEN ${skillProductVersions.status} = 'pending' AND ${skillProductVersions.price} = 0 THEN 0
        WHEN ${skillProductVersions.status} = 'pending' THEN 1
        ELSE 2
      END`,
      desc(skillProductVersions.createdAt)
    )
    .all()

  return rows.map(r => ({
    id: r.id,
    version: r.version,
    name: r.name,
    desc: r.desc,
    price: r.price,
    status: r.status,
    rejectReason: r.rejectReason,
    featured: r.featured,
    downloadCount: r.downloadCount,
    purchaseCount: r.purchaseCount,
    fileSize: r.fileSize,
    fileEntries: r.fileEntries ? JSON.parse(r.fileEntries) as { name: string, size: number, isDirectory: boolean }[] : [],
    sellerName: r.sellerName ?? '未知用户',
    sellerEmail: r.sellerEmail ?? '',
    createdAt: Number(r.createdAt),
    reviewedAt: r.reviewedAt ? Number(r.reviewedAt) : null
  }))
})