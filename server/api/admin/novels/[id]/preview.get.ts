// server/api/admin/novels/[id]/preview.get.ts
// 管理端在线预览:读取该小说最新提交版本的正文,连同版本元信息返回,供审核时查阅。
// 默认只返回正文开头 MAX_NOVEL_REVIEW_BYTES 字节(快速预览);?full=1 时解码整本返回全文(在线阅读审核)。
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { requireAdmin } from '../../../../utils/authz'
import { novelProductVersions } from '../../../../db/schema'
import { eq, desc } from 'drizzle-orm'
import { MAX_NOVEL_REVIEW_BYTES, countNovelChars } from '../../../../../shared/store-novel'
import { detectNovelEncoding } from '../../../../../shared/novel-encoding'

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
    sourceEncoding: novelProductVersions.sourceEncoding,
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
  // 默认只取开头 MAX_NOVEL_REVIEW_BYTES 字节(快速预览);?full=1 时解码整本返回全文(在线阅读审核)
  const full = getQuery(event).full === '1' || getQuery(event).full === 'true'
  const slice = full ? bytes : bytes.slice(0, MAX_NOVEL_REVIEW_BYTES)
  // 自适应格式检测:对预览/全文字节按乱码特征评分择优解码(Workers 支持 utf-8/gb18030/gbk;
  // Big5 等不支持标签会落到低置信,管理员可在浏览器端「一键转 UTF-8」修复)
  const detected = detectNovelEncoding(slice)
  const text = detected.text
  const truncated = !full && bytes.length > MAX_NOVEL_REVIEW_BYTES

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
    sourceEncoding: novel.sourceEncoding,
    detected: {
      encoding: detected.encoding,
      label: detected.label,
      garbledRatio: Number(detected.garbledRatio.toFixed(4)),
      confidence: detected.confidence
    },
    /** 正文解码文本:默认前 MAX_NOVEL_REVIEW_BYTES 字节;?full=1 时为全文 */
    content: text,
    truncated,
    /** 非截断时返回实际字数(全文或短文均为精确值) */
    actualChars: truncated ? null : countNovelChars(text)
  }
})
