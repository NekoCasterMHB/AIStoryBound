// server/api/store/mine.get.ts
// 商城「我的」数据(登录):
// - 已购买的 skill(含购买锁定版本号与可下载的已上架版本列表);
// - 我发布的 skill(含全部版本详情:版本号/状态/拒绝原因/大小/时间,发布者可下载任意版本)。
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { skillProducts, skillProductVersions, skillPurchases, user as usersTable } from '../../db/schema'
import { and, eq, inArray, desc } from 'drizzle-orm'
import { parseStoredTags } from '../../../shared/store-skill'
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
  const approvedBySkill = new Map<string, { version: number, createdAt: number }[]>()
  if (purchasedIds.length) {
    const approved = await db.select({
      skillId: skillProductVersions.skillId,
      version: skillProductVersions.version,
      createdAt: skillProductVersions.createdAt
    })
      .from(skillProductVersions)
      .where(and(
        inArray(skillProductVersions.skillId, purchasedIds),
        eq(skillProductVersions.status, 'approved'),
        // 禁用的版本用户侧不显示(购买锁定版本仍可下载)
        eq(skillProductVersions.enabled, 1)
      ))
      .orderBy(skillProductVersions.version)
      .all()
    for (const v of approved) {
      const list = approvedBySkill.get(v.skillId) ?? []
      list.push({ version: v.version, createdAt: Number(v.createdAt) })
      approvedBySkill.set(v.skillId, list)
    }
  }

  const published = await db.select({
    id: skillProducts.id,
    name: skillProducts.name,
    tags: skillProducts.tags,
    desc: skillProducts.desc,
    price: skillProducts.price,
    status: skillProducts.status,
    rejectReason: skillProducts.rejectReason,
    mainVersion: skillProducts.mainVersion,
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
      tags: skillProductVersions.tags,
      desc: skillProductVersions.desc,
      price: skillProductVersions.price,
      status: skillProductVersions.status,
      rejectReason: skillProductVersions.rejectReason,
      enabled: skillProductVersions.enabled,
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
        tags: parseStoredTags(v.tags),
        desc: v.desc,
        price: v.price,
        status: v.status as SkillStatus,
        rejectReason: v.rejectReason,
        enabled: v.enabled,
        fileSize: v.fileSize,
        createdAt: Number(v.createdAt)
      })
      versionsBySkill.set(v.skillId, list)
    }
  }

  return {
    purchased: purchased.filter(p => p.id !== null).map((p) => {
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
        versions: list && list.length ? list : [{ version: boughtVersion, createdAt: Number(p.purchasedAt) }]
      }
    }),
    published: published.map((p) => {
      const versions = versionsBySkill.get(p.id) ?? []
      return {
        id: p.id,
        name: p.name,
        tags: parseStoredTags(p.tags),
        desc: p.desc,
        price: p.price,
        status: p.status,
        rejectReason: p.rejectReason,
        mainVersion: p.mainVersion,
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
