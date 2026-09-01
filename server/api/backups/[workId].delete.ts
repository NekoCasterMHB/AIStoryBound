// server/api/backups/[workId].delete.ts
// 删除云端备份(登录用户):删 R2 对象 + D1 记录
import { requireUserId } from '../../utils/authz'
import { getSkillBucket } from '../../utils/r2'
import { getBackupByWork, deleteBackup } from '../../utils/backup-db'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const workId = getRouterParam(event, 'workId')
  if (!workId) throw createError({ statusCode: 400, statusMessage: '缺少 workId' })
  const row = await getBackupByWork(event, userId, workId)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Backup not found' })

  await getSkillBucket(event).delete(row.r2Key).catch(() => {})
  await deleteBackup(event, userId, workId)
  return { ok: true, id: workId }
})
