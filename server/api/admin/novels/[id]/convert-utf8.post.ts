// server/api/admin/novels/[id]/convert-utf8.post.ts
// 管理端「一键转 UTF-8」:body 为管理员浏览器端已完成编码识别与转换的 UTF-8 全文原始字节
// (浏览器 TextDecoder 支持 Big5 等全部编码,转换在客户端完成可绕开 Workers 解码标签限制)。
// 服务端严格校验 UTF-8 后写入新 R2 文件(保留原文件可回滚),并更新来源指向:
// 版本行 fileKey/fileSize/sourceEncoding;若该版本是主表当前展示快照,同步主表。
import { readRawBody } from 'h3'
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { requireAdmin } from '../../../../utils/authz'
import { novelProducts, novelProductVersions } from '../../../../db/schema'
import { eq, desc } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const bucket = getSkillBucket(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少小说 id' })

  const query = getQuery<{ version?: string }>(event)
  const want = Number(query.version)

  const rows = await db.select()
    .from(novelProductVersions)
    .where(eq(novelProductVersions.novelId, id))
    .orderBy(desc(novelProductVersions.version))
    .all()
  const target = Number.isInteger(want) && want > 0
    ? rows.find(v => v.version === want)
    : rows[0]
  if (!target) throw createError({ statusCode: 404, statusMessage: '小说版本不存在' })

  const body = await readRawBody(event, false)
  if (!body || body.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '缺少转换后的正文内容' })
  }
  const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  // 严格 UTF-8 校验:客户端转换结果必须是合法 UTF-8
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw createError({ statusCode: 400, statusMessage: '转换内容不是合法的 UTF-8 文本' })
  }

  // 新 key:原 key 去 .txt 后追加 -utf8;重复转换时落到同一个 key(幂等覆盖)
  const newKey = `${target.fileKey.replace(/\.txt$/i, '').replace(/-utf8$/i, '')}-utf8.txt`
  await bucket.put(newKey, bytes, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' }
  })

  await db.update(novelProductVersions)
    .set({ fileKey: newKey, fileSize: bytes.length, sourceEncoding: 'utf-8' })
    .where(eq(novelProductVersions.id, target.id))
    .run()

  // 主表 fileKey 若仍指向该版本旧文件(当前展示快照),同步更新,避免商城/下载仍取乱码源文件
  const productRows = await db.select({ fileKey: novelProducts.fileKey })
    .from(novelProducts)
    .where(eq(novelProducts.id, id))
    .all()
  if (productRows[0]?.fileKey === target.fileKey) {
    await db.update(novelProducts)
      .set({ fileKey: newKey, fileSize: bytes.length, sourceEncoding: 'utf-8', updatedAt: new Date() })
      .where(eq(novelProducts.id, id))
      .run()
  }

  return { ok: true, version: target.version, fileKey: newKey, fileSize: bytes.length, sourceEncoding: 'utf-8' }
})
