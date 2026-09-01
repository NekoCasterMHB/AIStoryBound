// server/api/backups/upload.post.ts
// 作品整包备份上传(登录用户):multipart(meta JSON + zip 二进制)→ 先写 R2(同 key 覆盖旧包)再 upsert D1 记录。
// 覆盖确认在客户端完成(先 GET /api/backups/[workId] 显示上次上传时间再上传),服务端不做二次校验。
import { requireUserId } from '../../utils/authz'
import { getSkillBucket } from '../../utils/r2'
import { backupR2Key, getBackupByWork, upsertBackup } from '../../utils/backup-db'

/** 备份包体积上限(与客户端 shareZip 的 MAX_ZIP_BYTES 一致) */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const parts = await readMultipartFormData(event).catch(() => null)
  if (!parts) throw createError({ statusCode: 400, statusMessage: '缺少请求体(multipart)' })

  const metaPart = parts.find(p => p.name === 'meta')
  const filePart = parts.find(p => p.name === 'file')
  if (!metaPart || !filePart?.data) {
    throw createError({ statusCode: 400, statusMessage: '缺少 meta 或 file 字段' })
  }
  if (filePart.data.byteLength > MAX_BACKUP_BYTES) {
    throw createError({ statusCode: 413, statusMessage: `备份包过大(上限 ${MAX_BACKUP_BYTES / 1024 / 1024}MB)` })
  }

  let meta: { workId?: unknown, title?: unknown, workUpdatedAt?: unknown, gameCount?: unknown, messageCount?: unknown }
  try {
    meta = JSON.parse(new TextDecoder().decode(metaPart.data)) as typeof meta
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'meta 无法解析为 JSON' })
  }
  const workId = typeof meta.workId === 'string' && meta.workId ? meta.workId : null
  if (!workId) throw createError({ statusCode: 400, statusMessage: '缺少 workId' })

  const r2Key = backupR2Key(userId, workId)
  const uploadedAt = new Date().toISOString()
  // 覆盖语义由客户端确认(先 GET 显示上次上传时间);服务端记录「是否已存在过」仅作回执
  const existed = !!(await getBackupByWork(event, userId, workId))

  // 先 R2 后 D1:R2 写失败直接报错(记录不落,用户可重传);D1 写失败则尽力删掉刚传的对象
  const bucket = getSkillBucket(event)
  await bucket.put(r2Key, filePart.data, { httpMetadata: { contentType: 'application/zip' } })
  try {
    await upsertBackup(event, {
      userId,
      workId,
      title: typeof meta.title === 'string' ? meta.title : null,
      r2Key,
      sizeBytes: filePart.data.byteLength,
      gameCount: typeof meta.gameCount === 'number' ? meta.gameCount : null,
      messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : null,
      workUpdatedAt: typeof meta.workUpdatedAt === 'string' ? meta.workUpdatedAt : null,
      uploadedAt
    })
  } catch (e) {
    await bucket.delete(r2Key).catch(() => {})
    throw e
  }

  return { ok: true, id: workId, existed, uploadedAt }
})
