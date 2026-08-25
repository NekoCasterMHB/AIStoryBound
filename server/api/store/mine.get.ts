// server/api/store/mine.get.ts
// 商城「我的」数据(登录):
// - 已购买的 skill(含购买锁定版本号与可下载的已上架版本列表);
// - 我发布的 skill(含全部版本详情:版本号/状态/拒绝原因/大小/时间,发布者可下载任意版本)。
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { skillProducts, skillProductVersions, skillPurchases, user as usersTable } from '../../db/schema'
import { and, eq, inArray, desc } from 'drizzle-orm'
import type { SkillStatus, SkillVersionBrief } from '../../../shared/store-skill'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)

  const purchased = await db.select({
    id: skillProducts.id,
    name: skillProducts.name,
    desc: skillProducts.desc,
    price: skillPurchases.price,
    sellerName: usersTable.name,
    featured: skillProducts.featured,
    purchasedAt: skillPurchases.createdAt,
    purchasedVersion: skillProductVersions.version,
    lockedVersionId: skillPurchases.skillVersionId
  })
    .from(skillPurchases)
    .leftJoin(skillProducts, eq(skillProducts.id, skillPurchases.skillId))
    .leftJoin(skillProductVersions, eq(skillProductVersions.id, skillPurchases.skillVersionId))
    .leftJoin(usersTable, eq(usersTable.id, skillProducts.sellerId))
    .where(eq(skillPurchases.buyerId, sessUser.id))
    .orderBy(desc(skillPurchases.createdAt))
    .all()

  const purchasedIds = purchased.map(p => p.id).filter((x): x is string => !!x)
  const approvedBySkill = new Map<string, number[]>()
  if (purchasedIds.length) {
    const approved = await db.select({ skillId: skillProductVersions.skillId, version: skillProductVersions.version })
      .from(skillProductVersions)
      .where(and(inArray(skillProductVersions.skillId, purchasedIds), eq(skillProductVersions.status, 'approved')))
      .orderBy(skillProductVersions.version)
      .all()
    for (const v of approved) {
      const list = approvedBySkill.get(v.skillId) ?? []
      list.push(v.version)
      approvedBySkill.set(v.skillId, list)
    }
  }

  const published = await db.select({
    id: skillProducts.id,
    name: skillProducts.name,
    desc: skillProducts.desc,
    price: skillProducts.price,
    status: skillProducts.status,
    rejectReason: skillProducts.rejectReason,
    featured: skillProducts.featured,
    downloadCount: skillProducts.downloadCount,
    purchaseCount: skillProducts.purchaseCount,
    createdAt: skillProducts.createdAt
  })
    .from(skillProducts)
    .where(eq(skillProducts.sellerId, sessUser.id))
    .orderBy(desc(skillProducts.createdAt))
    .all()

  const publishedIds = published.map(p => p.id)
  const versionsBySkill = new Map<string, SkillVersionBrief[]>()
  if (publishedIds.length) {
    const versionRows = await db.select({
      skillId: skillProductVersions.skillId,
      version: skillProductVersions.version,
      name: skillProductVersions.name,
      desc: skillProductVersions.desc,
      price: skillProductVersions.price,
      status: skillProductVersions.status,
      rejectReason: skillProductVersions.rejectReason,
      fileSize: skillProductVersions.fileSize,
      createdAt: skillProductVersions.createdAt
    })
      .from(skillProductVersions)
      .where(inArray(skillProductVersions.skillId, publishedIds))
      .orderBy(desc(skillProductVersions.version))
      .all()
    for (const v of versionRows) {
      const list = versionsBySkill.get(v.skillId) ?? []
      list.push({
        version: v.version,
        name: v.name,
        desc: v.desc,
        price: v.price,
        status: v.status as SkillStatus,
        rejectReason: v.rejectReason,
        fileSize: v.fileSize,
        createdAt: Number(v.createdAt)
      })
      versionsBySkill.set(v.skillId, list)
    }
  }

  return {
    purchased: purchased.filter(p => p.id !== null).map(p => {
      const id = p.id as string
      const boughtVersion = p.purchasedVersion ?? 1
      const list = approvedBySkill.get(id)
      return {
        id,
        name: p.name ?? '未知 Skill',
        desc: p.desc ?? '',
        price: p.price,
        sellerName: p.sellerName ?? '未知用户',
        featured: p.featured,
        purchasedAt: Number(p.purchasedAt),
        purchasedVersion: boughtVersion,
        versions: list && list.length ? list : [boughtVersion]
      }
    }),
    published: published.map(p => {
      const versions = versionsBySkill.get(p.id) ?? []
      return {
        id: p.id,
        name: p.name,
        desc: p.desc,
        price: p.price,
        status: p.status,
        rejectReason: p.rejectReason,
        featured: p.featured,
        downloadCount: p.downloadCount,
        purchaseCount: p.purchaseCount,
        createdAt: Number(p.createdAt),
        latestVersion: versions[0]?.version ?? 1,
        versions
      }
    })
  }
})