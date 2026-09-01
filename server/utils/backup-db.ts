// server/utils/backup-db.ts
// 作品整包备份数据访问层(D1 work_backups 表;ZIP 本体在 R2 SKILL_FILES,键 backups/<userId>/<workId>.zip)
import type { H3Event } from 'h3'
import { and, desc, eq } from 'drizzle-orm'
import { useD1 } from './d1'
import { workBackups } from '../db/schema'
import { uuid } from '../../shared/novel'

export interface WorkBackupRow {
  id: string
  userId: string
  workId: string
  title: string | null
  r2Key: string
  sizeBytes: number | null
  gameCount: number | null
  messageCount: number | null
  workUpdatedAt: string | null
  uploadedAt: string
}

function mapBackup(r: typeof workBackups.$inferSelect): WorkBackupRow {
  return {
    id: r.id,
    userId: r.userId,
    workId: r.workId,
    title: r.title,
    r2Key: r.r2Key,
    sizeBytes: r.sizeBytes,
    gameCount: r.gameCount,
    messageCount: r.messageCount,
    workUpdatedAt: r.workUpdatedAt,
    uploadedAt: r.uploadedAt
  }
}

/** R2 对象键:同 key 反复 put 即覆盖旧对象(等效「删除旧 zip」) */
export function backupR2Key(userId: string, workId: string): string {
  return `backups/${userId}/${workId}.zip`
}

/** 按 (userId, workId) 查单条备份(上传前「是否传过」预查 / 下载与删除的归属校验) */
export async function getBackupByWork(event: H3Event, userId: string, workId: string): Promise<WorkBackupRow | null> {
  const rows = await useD1(event).select().from(workBackups)
    .where(and(eq(workBackups.userId, userId), eq(workBackups.workId, workId)))
    .all()
  return rows[0] ? mapBackup(rows[0]) : null
}

export async function listBackupsByUser(event: H3Event, userId: string): Promise<WorkBackupRow[]> {
  const rows = await useD1(event).select().from(workBackups)
    .where(eq(workBackups.userId, userId))
    .orderBy(desc(workBackups.uploadedAt))
    .all()
  return rows.map(mapBackup)
}

/** upsert(按 userId+workId 唯一):存在则更新,不存在则插入 */
export async function upsertBackup(event: H3Event, data: {
  userId: string
  workId: string
  title: string | null
  r2Key: string
  sizeBytes: number | null
  gameCount: number | null
  messageCount: number | null
  workUpdatedAt: string | null
  uploadedAt: string
}): Promise<void> {
  const db = useD1(event)
  const existing = await getBackupByWork(event, data.userId, data.workId)
  if (existing) {
    await db.update(workBackups).set({
      title: data.title,
      r2Key: data.r2Key,
      sizeBytes: data.sizeBytes,
      gameCount: data.gameCount,
      messageCount: data.messageCount,
      workUpdatedAt: data.workUpdatedAt,
      uploadedAt: data.uploadedAt
    }).where(eq(workBackups.id, existing.id)).run()
  } else {
    await db.insert(workBackups).values({
      id: uuid(),
      userId: data.userId,
      workId: data.workId,
      title: data.title,
      r2Key: data.r2Key,
      sizeBytes: data.sizeBytes,
      gameCount: data.gameCount,
      messageCount: data.messageCount,
      workUpdatedAt: data.workUpdatedAt,
      uploadedAt: data.uploadedAt
    }).run()
  }
}

/** 删除 D1 记录(存在才删;R2 对象的删除由调用方负责) */
export async function deleteBackup(event: H3Event, userId: string, workId: string): Promise<boolean> {
  const existing = await getBackupByWork(event, userId, workId)
  if (!existing) return false
  await useD1(event).delete(workBackups).where(eq(workBackups.id, existing.id)).run()
  return true
}
