// server/api/store/novels/mine.get.ts
// 小说商城「我的」数据(登录,创意工坊「书架」):
// - 已购买的小说(含购买锁定版本号与可下载的已上架版本列表);
// - 我发布的小说(含全部版本详情:版本号/状态/拒绝原因/大小/时间,发布者可下载任意版本)。
import { useD1 } from '../../../utils/d1'
import { requireUser } from '../../../utils/authz'
import { novelProducts, novelProductVersions, novelPurchases, user as usersTable } from '../../../db/schema'
import { and, eq, inArray, desc } from 'drizzle-orm'
import type { NovelStatus, NovelVersionBrief } from '../../../../shared/store-novel'

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const db = useD1(event)

  const purchased = await db.select({
    id: novelProducts.id,
    title: novelProducts.title,
    desc: novelProducts.desc,
    price: novelPurchases.price,
    sellerName: usersTable.name,
    featured: novelProducts.featured,
    purchasedAt: novelPurchases.createdAt,
    purchasedVersion: novelProductVersions.version,
    lockedVersionId: novelPurchases.novelVersionId
  })
    .from(novelPurchases)
    .leftJoin(novelProducts, eq(novelProducts.id, novelPurchases.novelId))
    .leftJoin(novelProductVersions, eq(novelProductVersions.id, novelPurchases.novelVersionId))
    .leftJoin(usersTable, eq(usersTable.id, novelProducts.sellerId))
    .where(eq(novelPurchases.buyerId, sessUser.id))
    .orderBy(desc(novelPurchases.createdAt))
    .all()

  const purchasedIds = purchased.map(p => p.id).filter((x): x is string => !!x)
  const approvedByNovel = new Map<string, { version: number, createdAt: number }[]>()
  if (purchasedIds.length) {
    const approved = await db.select({
      novelId: novelProductVersions.novelId,
      version: novelProductVersions.version,
      createdAt: novelProductVersions.createdAt
    })
      .from(novelProductVersions)
      .where(and(
        inArray(novelProductVersions.novelId, purchasedIds),
        eq(novelProductVersions.status, 'approved'),
        // 禁用的版本用户侧不显示(购买锁定版本仍可下载)
        eq(novelProductVersions.enabled, 1)
      ))
      .orderBy(novelProductVersions.version)
      .all()
    for (const v of approved) {
      const list = approvedByNovel.get(v.novelId) ?? []
      list.push({ version: v.version, createdAt: Number(v.createdAt) })
      approvedByNovel.set(v.novelId, list)
    }
  }

  const published = await db.select({
    id: novelProducts.id,
    title: novelProducts.title,
    author: novelProducts.author,
    desc: novelProducts.desc,
    price: novelProducts.price,
    previewChars: novelProducts.previewChars,
    totalChars: novelProducts.totalChars,
    status: novelProducts.status,
    rejectReason: novelProducts.rejectReason,
    mainVersion: novelProducts.mainVersion,
    featured: novelProducts.featured,
    downloadCount: novelProducts.downloadCount,
    purchaseCount: novelProducts.purchaseCount,
    createdAt: novelProducts.createdAt
  })
    .from(novelProducts)
    .where(eq(novelProducts.sellerId, sessUser.id))
    .orderBy(desc(novelProducts.createdAt))
    .all()

  const publishedIds = published.map(p => p.id)
  const versionsByNovel = new Map<string, NovelVersionBrief[]>()
  if (publishedIds.length) {
    const versionRows = await db.select({
      novelId: novelProductVersions.novelId,
      version: novelProductVersions.version,
      title: novelProductVersions.title,
      author: novelProductVersions.author,
      desc: novelProductVersions.desc,
      price: novelProductVersions.price,
      previewChars: novelProductVersions.previewChars,
      totalChars: novelProductVersions.totalChars,
      status: novelProductVersions.status,
      rejectReason: novelProductVersions.rejectReason,
      enabled: novelProductVersions.enabled,
      fileSize: novelProductVersions.fileSize,
      createdAt: novelProductVersions.createdAt
    })
      .from(novelProductVersions)
      .where(inArray(novelProductVersions.novelId, publishedIds))
      .orderBy(desc(novelProductVersions.version))
      .all()
    for (const v of versionRows) {
      const list = versionsByNovel.get(v.novelId) ?? []
      list.push({
        version: v.version,
        title: v.title,
        author: v.author,
        desc: v.desc,
        price: v.price,
        previewChars: v.previewChars,
        totalChars: v.totalChars,
        status: v.status as NovelStatus,
        rejectReason: v.rejectReason,
        enabled: v.enabled,
        fileSize: v.fileSize,
        createdAt: Number(v.createdAt)
      })
      versionsByNovel.set(v.novelId, list)
    }
  }

  return {
    purchased: purchased.filter(p => p.id !== null).map((p) => {
      const id = p.id as string
      const boughtVersion = p.purchasedVersion ?? 1
      const list = approvedByNovel.get(id)
      return {
        id,
        title: p.title ?? '未知小说',
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
      const versions = versionsByNovel.get(p.id) ?? []
      return {
        id: p.id,
        title: p.title,
        author: p.author,
        desc: p.desc,
        price: p.price,
        previewChars: p.previewChars,
        totalChars: p.totalChars,
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
