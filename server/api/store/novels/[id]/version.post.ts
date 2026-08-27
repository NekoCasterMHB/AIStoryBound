// server/api/store/novels/[id]/version.post.ts
// 版本管理(仅限本人商品):
// - main=true    设置主版本:把指定版本快照(书名/作者/简介/价格/预览字数)同步到商品主表,
//                成为书架商城展示的主版本;仅已上架版本可设,设为主版本时自动启用(主版本必须在用户侧可见);
// - enabled=true/false 启用/禁用版本:仅已上架版本可启停;禁用的版本用户侧不显示(商城版本菜单、
//                已购版本列表均隐藏),但已购者仍可下载其购买锁定的版本;主版本不允许禁用。
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { novelProducts, novelProductVersions } from '../../../../db/schema'
import { and, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少小说 id' })

  const body = await readBody<{ version?: unknown, main?: unknown, enabled?: unknown }>(event).catch(() => null)
  const version = Number(body?.version)
  if (!Number.isInteger(version) || version < 1) {
    throw createError({ statusCode: 400, statusMessage: '请指定有效的版本号' })
  }
  const setMain = body?.main === true
  const enableValue = body?.enabled === true
  const setEnabled = typeof body?.enabled === 'boolean'
  if (!setMain && !setEnabled) {
    throw createError({ statusCode: 400, statusMessage: '请指定操作(设置主版本或启用/禁用版本)' })
  }

  const productRows = await db.select({ id: novelProducts.id, mainVersion: novelProducts.mainVersion })
    .from(novelProducts)
    .where(and(eq(novelProducts.id, id), eq(novelProducts.sellerId, user.id)))
    .all()
  const product = productRows[0]
  if (!product) {
    throw createError({ statusCode: 404, statusMessage: '小说不存在或不属于你' })
  }

  const versionRows = await db.select({
    id: novelProductVersions.id,
    version: novelProductVersions.version,
    status: novelProductVersions.status,
    enabled: novelProductVersions.enabled,
    title: novelProductVersions.title,
    author: novelProductVersions.author,
    desc: novelProductVersions.desc,
    price: novelProductVersions.price,
    previewChars: novelProductVersions.previewChars,
    totalChars: novelProductVersions.totalChars
  })
    .from(novelProductVersions)
    .where(and(eq(novelProductVersions.novelId, id), eq(novelProductVersions.version, version)))
    .all()
  const row = versionRows[0]
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: `版本 v${version} 不存在` })
  }
  if (row.status !== 'approved') {
    throw createError({ statusCode: 400, statusMessage: '仅已上架(审核通过)的版本可设置主版本或启停' })
  }

  if (setMain) {
    // 版本快照同步到主表,成为书架商城展示的新主版本(同时自动启用)
    await db.update(novelProducts)
      .set({
        title: row.title,
        author: row.author,
        desc: row.desc,
        price: row.price,
        previewChars: row.previewChars,
        totalChars: row.totalChars,
        mainVersion: version,
        updatedAt: new Date()
      })
      .where(eq(novelProducts.id, id))
      .run()
    if (row.enabled !== 1) {
      await db.update(novelProductVersions)
        .set({ enabled: 1 })
        .where(eq(novelProductVersions.id, row.id))
        .run()
    }
  }
  if (setEnabled) {
    if (!enableValue && product.mainVersion === version) {
      throw createError({ statusCode: 400, statusMessage: '主版本不允许禁用,请先切换主版本' })
    }
    await db.update(novelProductVersions)
      .set({ enabled: enableValue ? 1 : 0 })
      .where(eq(novelProductVersions.id, row.id))
      .run()
  }

  return { ok: true, version }
})
