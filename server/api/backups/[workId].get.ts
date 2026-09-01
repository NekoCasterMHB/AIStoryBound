// server/api/backups/[workId].get.ts
// 单条备份记录(上传前「是否传过」预查:存在返回上次上传时间,未传过 404)
import { requireUserId } from '../../utils/authz'
import { getBackupByWork } from '../../utils/backup-db'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const workId = getRouterParam(event, 'workId')
  if (!workId) throw createError({ statusCode: 400, statusMessage: '缺少 workId' })
  const row = await getBackupByWork(event, userId, workId)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Backup not found' })
  return {
    workId: row.workId,
    title: row.title,
    uploadedAt: row.uploadedAt,
    workUpdatedAt: row.workUpdatedAt,
    gameCount: row.gameCount,
    messageCount: row.messageCount,
    sizeBytes: row.sizeBytes
  }
})
