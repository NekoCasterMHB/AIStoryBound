// server/api/backups/[workId]/download.get.ts
// 下载备份 ZIP(登录用户,归属校验后返回字节;客户端解压并导入本地)
import { requireUserId } from '../../../utils/authz'
import { getSkillBucket } from '../../../utils/r2'
import { getBackupByWork } from '../../../utils/backup-db'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const workId = getRouterParam(event, 'workId')
  if (!workId) throw createError({ statusCode: 400, statusMessage: '缺少 workId' })
  const row = await getBackupByWork(event, userId, workId)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Backup not found' })

  const obj = await getSkillBucket(event).get(row.r2Key)
  if (!obj) throw createError({ statusCode: 404, statusMessage: 'Backup file missing' })
  const bytes = await obj.arrayBuffer()

  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(row.title ?? 'work-backup')}.zip"`
  })
  return new Response(bytes)
})
