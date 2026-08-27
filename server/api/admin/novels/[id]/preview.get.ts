// server/api/admin/novels/[id]/preview.get.ts
// 管理端在线预览:读取该小说最新提交版本的正文(前 MAX_NOVEL_REVIEW_BYTES 字节解码),
// 连同版本元信息返回,供审核时查阅;全文核对走「下载审核」。
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { requireAdmin } from '../../../../utils/authz'
import { novelProductVersions } from '../../../../db/schema'
import { eq, desc } from 'drizzle-orm'
import { MAX_NOVEL_REVIEW_BYTES, decodeNovelText, countNovelChars } from '../../../../../shared/store-novel'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少小说 id' })

  const rows = await db.select({
    version: novelProductVersions.version,
    title: novelProductVersions.title,
    author: novelProductVersions.author,
    desc: novelProductVersions.desc,
    price: novelProductVersions.price,
    previewChars: novelProductVersions.previewChars,
    totalChars: novelProductVersions.totalChars,
    fileSize: novelProductVersions.fileSize,
    fileKey: novelProductVersions.fileKey,
    status: novelProductVersions.status,
    rejectReason: novelProductVersions.rejectReason
  })
    .from(novelProductVersions)
    .where(eq(novelProductVersions.novelId, id))
    .orderBy(desc(novelProductVersions.version))
    .limit(1)
    .all()
  const novel = rows[0]
  if (!novel) throw createError({ statusCode: 404, statusMessage: '小说不存在' })

  const object = await getSkillBucket(event).get(novel.fileKey)
  if (!object) {
    throw createError({ statusCode: 404, statusMessage: '小说文件不存在或已被删除' })
  }

  const bytes = new Uint8Array(await object.arrayBuffer())
  const head = bytes.slice(0, MAX_NOVEL_REVIEW_BYTES)
  const text = decodeNovelText(head)
  const truncated = bytes.length > MAX_NOVEL_REVIEW_BYTES

  return {
    version: novel.version,
    title: novel.title,
    author: novel.author,
    desc: novel.desc,
    price: novel.price,
    previewChars: novel.previewChars,
    totalChars: novel.totalChars,
    fileSize: novel.fileSize,
    status: novel.status,
    rejectReason: novel.rejectReason,
    /** 正文前 MAX_NOVEL_REVIEW_BYTES 字节解码后的文本(超长截断) */
    content: text,
    truncated,
    /** 是否超长:true 时建议「下载审核」核对全文 */
    actualChars: truncated ? null : countNovelChars(text)
  }
})
