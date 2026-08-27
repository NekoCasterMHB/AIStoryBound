// server/api/store/novels.post.ts
// 发布/更新小说(multipart 表单):title / author / desc / price / previewChars / file(txt),可选 novelId=更新模式。
// 首次发布:创建商品主表(status=pending)+ 版本 v1,均为待审核。
// 更新:在原商品下追加新版本(版本号自动递增,独立 R2 文件,旧文件保留),新版本待审核;
//      审核通过前商店继续售卖旧版本(主表保持原在售快照,通过后由审核接口同步)。
// 校验:txt 可解码(UTF-8 优先,回退 GBK)、字数 ≥ MIN_NOVEL_CHARS、可预览字数 ≤ 全书字数且 ≤ 上限。
import { readMultipartFormData } from 'h3'
import { useD1 } from '../../utils/d1'
import { getSkillBucket } from '../../utils/r2'
import { requireUser } from '../../utils/authz'
import { novelProducts, novelProductVersions } from '../../db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { uuid } from '../../../shared/novel'
import {
  MAX_NOVEL_TITLE_CHARS,
  MAX_NOVEL_AUTHOR_CHARS,
  MAX_NOVEL_DESC_CHARS,
  MAX_NOVEL_TXT_BYTES,
  MAX_NOVEL_PREVIEW_CHARS,
  MIN_NOVEL_CHARS,
  NOVEL_TXT_EXTENSIONS,
  decodeNovelText,
  countNovelChars
} from '../../../shared/store-novel'

const textOf = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array())

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useD1(event)
  const bucket = getSkillBucket(event)

  const parts = await readMultipartFormData(event)
  if (!parts) throw createError({ statusCode: 400, statusMessage: '请提交完整的发布表单' })

  const title = textOf(parts.find(p => p.name === 'title')?.data).trim()
  const author = textOf(parts.find(p => p.name === 'author')?.data).trim() || null
  const desc = textOf(parts.find(p => p.name === 'desc')?.data).trim()
  let price = Math.floor(Number(textOf(parts.find(p => p.name === 'price')?.data)))
  const previewChars = Math.floor(Number(textOf(parts.find(p => p.name === 'previewChars')?.data)))
  const novelId = textOf(parts.find(p => p.name === 'novelId')?.data).trim()
  const filePart = parts.find(p => p.name === 'file' && !!p.filename)

  if (!title || title.length > MAX_NOVEL_TITLE_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `书名需在 1~${MAX_NOVEL_TITLE_CHARS} 字之间` })
  }
  if (author && author.length > MAX_NOVEL_AUTHOR_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `作者名不能超过 ${MAX_NOVEL_AUTHOR_CHARS} 字` })
  }
  if (!desc || desc.length > MAX_NOVEL_DESC_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `请填写一句话简介(≤${MAX_NOVEL_DESC_CHARS} 字,展示在书架卡片上)` })
  }
  if (!Number.isFinite(price) || price < 0) {
    throw createError({ statusCode: 400, statusMessage: '售价需为不小于 0 的整数 token(0 表示免费)' })
  }
  const fileName = filePart?.filename ?? ''
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (!NOVEL_TXT_EXTENSIONS.includes(ext)) {
    throw createError({ statusCode: 400, statusMessage: '请上传 .txt 文本文件' })
  }
  const fileData = filePart?.data
  if (!fileData || fileData.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '小说正文为空' })
  }
  if (fileData.length > MAX_NOVEL_TXT_BYTES) {
    throw createError({ statusCode: 400, statusMessage: `小说正文超过 ${MAX_NOVEL_TXT_BYTES / 1024 / 1024}MB 上限` })
  }

  // 解码 + 字数校验:UTF-8 优先,回退 GBK(国内 TXT 常见编码)
  const text = decodeNovelText(fileData)
  const totalChars = countNovelChars(text)
  if (totalChars < MIN_NOVEL_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `小说正文过短(至少 ${MIN_NOVEL_CHARS} 字才能上架)` })
  }
  if (!Number.isInteger(previewChars) || previewChars < 0 || previewChars > MAX_NOVEL_PREVIEW_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `可预览字数需在 0~${MAX_NOVEL_PREVIEW_CHARS} 之间(0=不可预览)` })
  }
  if (previewChars > totalChars) {
    throw createError({ statusCode: 400, statusMessage: `可预览字数(${previewChars})不能超过全书字数(${totalChars})` })
  }

  // 更新模式:校验商品归属,版本号自动递增,售价沿用主表当前值(更新不允许变更售价)
  let productId: string
  let version: number
  if (novelId) {
    const rows = await db.select({ id: novelProducts.id, price: novelProducts.price })
      .from(novelProducts)
      .where(and(eq(novelProducts.id, novelId), eq(novelProducts.sellerId, user.id)))
      .all()
    const row = rows[0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: '小说不存在或不属于你' })
    }
    productId = novelId
    price = row.price
    const maxRow = await db.select({ m: sql<number>`max(${novelProductVersions.version})` })
      .from(novelProductVersions)
      .where(eq(novelProductVersions.novelId, novelId))
      .all()
    version = (maxRow[0]?.m ?? 0) + 1
  } else {
    productId = uuid()
    version = 1
  }

  const fileKey = version === 1
    ? `novels/${user.id}/${productId}.txt`
    : `novels/${user.id}/${productId}-v${version}.txt`
  await bucket.put(fileKey, fileData, {
    httpMetadata: { contentType: 'text/plain' }
  })

  const now = new Date()
  if (version === 1) {
    await db.insert(novelProducts).values({
      id: productId,
      sellerId: user.id,
      title,
      author,
      desc,
      price,
      previewChars,
      totalChars,
      fileKey,
      fileName,
      fileSize: fileData.length,
      status: 'pending',
      featured: 0,
      downloadCount: 0,
      purchaseCount: 0,
      createdAt: now,
      updatedAt: now
    }).run()
  }

  await db.insert(novelProductVersions).values({
    id: uuid(),
    novelId: productId,
    version,
    title,
    author,
    desc,
    price,
    previewChars,
    totalChars,
    fileKey,
    fileName,
    fileSize: fileData.length,
    status: 'pending',
    createdAt: now
  }).run()

  return { ok: true, id: productId, version, status: 'pending' }
})
