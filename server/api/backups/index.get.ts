// server/api/backups/index.get.ts
// 云端备份列表(登录用户;书架合并的「云端备份」区块数据源)
import { requireUserId } from '../../utils/authz'
import { listBackupsByUser } from '../../utils/backup-db'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const rows = await listBackupsByUser(event, userId)
  return rows.map(r => ({
    workId: r.workId,
    title: r.title,
    uploadedAt: r.uploadedAt,
    workUpdatedAt: r.workUpdatedAt,
    gameCount: r.gameCount,
    messageCount: r.messageCount,
    sizeBytes: r.sizeBytes
  }))
})
