// server/api/store/skills.get.ts
// Skill 商城商品列表(公开):仅返回已上架(approved)且至少有一个已上架版本的商品,免费(price=0)优先、推荐在前、新品在后;
// 登录用户附带 owned 标记(是否已购买/是否自己发布,便于前端切换"购买/下载"按钮)。
import { useD1 } from '../../utils/d1'
import { getSessionUser } from '../../utils/authz'
import { skillProducts, skillProductVersions, skillPurchases, user as usersTable } from '../../db/schema'
import { and, eq, desc, sql } from 'drizzle-orm'
import { parseStoredTags } from '../../../shared/store-skill'

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
    sellerId: skillProducts.sellerId,
    createdAt: skillProducts.createdAt,
    mainVersion: skillProducts.mainVersion,
    icon: skillProducts.icon,
    tags: skillProducts.tags,
    readme: skillProducts.readme
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

  // 各商品已上架且启用的版本(「获取技能」版本切换;禁用的版本用户侧不显示)
  const verRows = await db.select({
    skillId: skillProductVersions.skillId,
    version: skillProductVersions.version,
    createdAt: skillProductVersions.createdAt
  })
    .from(skillProductVersions)
    .where(and(eq(skillProductVersions.status, 'approved'), eq(skillProductVersions.enabled, 1)))
    .orderBy(desc(skillProductVersions.version))
    .all()
  const versionsBySkill = new Map<string, { version: number, createdAt: number }[]>()
  for (const v of verRows) {
    const list = versionsBySkill.get(v.skillId) ?? []
    list.push({ version: v.version, createdAt: Number(v.createdAt) })
    versionsBySkill.set(v.skillId, list)
  }

  // 已登录时查询其购买集+自己发布的商品(未登录置全部 false)
  const sessionUser = await getSessionUser(event)
  const ownedIds = new Set<string>()
  const purchasedIds = new Set<string>()
  if (sessionUser) {
    const owned = await db.select({ skillId: skillPurchases.skillId })
      .from(skillPurchases)
      .where(eq(skillPurchases.buyerId, sessionUser.id))
      .all()
    for (const o of owned) {
      purchasedIds.add(o.skillId)
      ownedIds.add(o.skillId)
    }
    // 自己是发布者的商品等同拥有(前端显示"下载"而非"购买/免费获取",避免自购 400)
    for (const r of rows) {
      if (r.sellerId === sessionUser.id) ownedIds.add(r.id)
    }
  }

  return rows
    // 防御:商品状态 approved 但没有任何已上架版本(历史脏数据)时不在商城展示
    .filter(r => (versionsBySkill.get(r.id)?.length ?? 0) > 0)
    .map(r => ({
      id: r.id,
      name: r.name,
      desc: r.desc,
      price: r.price,
      sellerName: r.sellerName ?? '未知用户',
      featured: r.featured,
      downloadCount: r.downloadCount,
      purchaseCount: r.purchaseCount,
      createdAt: Number(r.createdAt),
      owned: ownedIds.has(r.id),
      purchased: purchasedIds.has(r.id),
      icon: r.icon,
      mainVersion: r.mainVersion,
      tags: parseStoredTags(r.tags),
      versions: versionsBySkill.get(r.id) ?? [],
      // readme 为压缩包内 README 内容摘要(≤2000 字),前端取第一段展示在卡片上
      readme: r.readme ?? ''
    }))
})
