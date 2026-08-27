// server/api/store/novels/[id]/preview.get.ts
// 小说在线预览(公开,游客可访问):读取最新已上架版本的正文,返回前 previewChars 字(发布者设定)供免费试读。
// 权限:免费商品 / 已购买 / 发布者 / 管理员可看全文(canViewAll=true,客户端走下载接口取全文);
// 未付费游客仅可读前 previewChars 字(以及书名/简介/字数等元信息)。
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { getSessionUser, isAdmin } from '../../../../utils/authz'
import { novelProducts, novelProductVersions, novelPurchases } from '../../../../db/schema'
import { and, eq, desc } from 'drizzle-orm'
import { decodeNovelText, takeNovelPreview } from '../../../../../shared/store-novel'

export default defineEventHandler(async (event) => {
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少小说 id' })

  const rows = await db.select().from(novelProducts).where(eq(novelProducts.id, id)).all()
  const novel = rows[0]
  if (!novel) throw createError({ statusCode: 404, statusMessage: '小说不存在' })

  // 预览对象 = 最新已上架版本
  const saleRows = await db.select({
    fileKey: novelProductVersions.fileKey,
    title: novelProductVersions.title,
    author: novelProductVersions.author,
    desc: novelProductVersions.desc,
    price: novelProductVersions.price,
    previewChars: novelProductVersions.previewChars,
    totalChars: novelProductVersions.totalChars
  })
    .from(novelProductVersions)
    .where(and(eq(novelProductVersions.novelId, id), eq(novelProductVersions.status, 'approved')))
    .orderBy(desc(novelProductVersions.version))
    .limit(1)
    .all()
  const saleRow = saleRows[0]
  if (!saleRow) throw createError({ statusCode: 404, statusMessage: '该小说暂无已上架版本' })

  // 权限:免费商品直接解锁;登录用户按 发布者/管理员/已购买 判定
  let canViewAll = saleRow.price === 0
  const sessionUser = await getSessionUser(event)
  if (sessionUser && !canViewAll) {
    if (novel.sellerId === sessionUser.id || await isAdmin(event, sessionUser)) {
      canViewAll = true
    } else {
      const owned = await db.select({ id: novelPurchases.id })
        .from(novelPurchases)
        .where(and(eq(novelPurchases.novelId, id), eq(novelPurchases.buyerId, sessionUser.id)))
        .all()
      canViewAll = owned.length > 0
    }
  }

  const object = await getSkillBucket(event).get(saleRow.fileKey)
  if (!object) {
    throw createError({ statusCode: 404, statusMessage: '小说文件不存在或已被删除' })
  }

  const text = decodeNovelText(new Uint8Array(await object.arrayBuffer()))
  // 预览字数以版本快照为准;正文实际字数与快照不一致(理论上同一次提交)时按快照截取
  const preview = takeNovelPreview(text, saleRow.previewChars)

  return {
    id: novel.id,
    title: saleRow.title,
    author: saleRow.author,
    desc: saleRow.desc,
    price: saleRow.price,
    previewChars: saleRow.previewChars,
    totalChars: saleRow.totalChars,
    canViewAll,
    /** 前 previewChars 字正文(未付费可读部分) */
    preview
  }
})
