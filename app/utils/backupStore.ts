// app/utils/backupStore.ts
// 作品整包备份(书架「同步云端」):本地为真源,把作品 + 其全部游戏会话 + 存盘点打包成 ZIP,
// 上传 R2(服务端 D1 记录元数据);下载时取回 ZIP 自动解压导入本地。
// 与 shareZip(分享包,还原时重造作品 id)不同:备份包保留原 id——游戏按 workId 关联,且覆盖检测依赖同 id。
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { LocalWork, LocalGame } from '#shared/novel'
import { BACKUP_FORMAT, BACKUP_VERSION, BACKUP_ENTRIES, type BackupManifest } from '#shared/share-format'
import { getWork, saveWork } from './worldGen'
import { listLocalGames, restoreLocalGame } from './gameStore'
import { listGamePoints, saveGamePoint, type GameSavePoint } from './gameSaveStore'

/** 备份包体积上限(与服务端 upload 守卫一致) */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024

// ---- 打包 ----

export interface WorkBackupMeta {
  workId: string
  title: string
  workUpdatedAt: string
  gameCount: number
  messageCount: number
}

export interface WorkBackupBundle {
  zip: Uint8Array
  meta: WorkBackupMeta
}

/** 组装某作品的整包备份 ZIP(work + games + saves,JSON 平铺;纯数据,直接结构化克隆) */
export async function buildWorkBackupZip(workId: string): Promise<WorkBackupBundle> {
  const work = await getWork(workId)
  if (!work) throw new Error('本地未找到该作品')
  const games = (await listLocalGames()).filter(g => g.workId === workId)
  const saves: GameSavePoint[] = []
  for (const g of games) {
    saves.push(...await listGamePoints(g.id))
  }
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kind: 'work-backup',
    workId,
    exportedAt: new Date().toISOString(),
    gameCount: games.length
  }
  const zip = zipSync({
    [BACKUP_ENTRIES.manifest]: strToU8(JSON.stringify(manifest)),
    [BACKUP_ENTRIES.work]: strToU8(JSON.stringify(work)),
    [BACKUP_ENTRIES.games]: strToU8(JSON.stringify(games)),
    [BACKUP_ENTRIES.saves]: strToU8(JSON.stringify(saves))
  }, { level: 6 })
  return {
    zip,
    meta: {
      workId,
      title: work.title,
      workUpdatedAt: work.updatedAt ?? work.createdAt,
      gameCount: games.length,
      messageCount: games.reduce((n, g) => n + g.messages.length, 0)
    }
  }
}

// ---- 解包 ----

export interface ParsedBackup {
  work: LocalWork
  games: LocalGame[]
  saves: GameSavePoint[]
}

/** 解析备份 ZIP 并校验 manifest;作品保留原 id、标记 synced(与云端镜像一致) */
export function parseWorkBackupZip(bytes: Uint8Array): ParsedBackup {
  if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('备份包过大')
  let unzipped: ReturnType<typeof unzipSync>
  try {
    unzipped = unzipSync(bytes)
  } catch {
    throw new Error('备份包不是有效的 ZIP')
  }
  const read = (name: string): string => {
    const entry = unzipped[name] ?? unzipped[Object.keys(unzipped).find(k => k.split('/').pop() === name) ?? '']
    if (!entry) throw new Error(`备份包缺少 ${name}`)
    return strFromU8(entry)
  }
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(read(BACKUP_ENTRIES.manifest)) as BackupManifest
  } catch {
    throw new Error('备份包缺少清单')
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION || manifest.kind !== 'work-backup') {
    throw new Error('不是有效的作品备份包')
  }
  const work = JSON.parse(read(BACKUP_ENTRIES.work)) as LocalWork
  if (!work?.id) throw new Error('备份包缺少作品数据')
  work.syncStatus = 'synced'
  let games: LocalGame[] = []
  let saves: GameSavePoint[] = []
  try { games = (JSON.parse(read(BACKUP_ENTRIES.games)) as LocalGame[] ?? []).map(g => ({ ...g, syncStatus: 'synced' as const })) } catch { games = [] }
  try { saves = (JSON.parse(read(BACKUP_ENTRIES.saves)) as GameSavePoint[] ?? []) } catch { saves = [] }
  return { work, games, saves }
}

/** 把解析出的备份写入本地三个库(游戏/存盘点原样写回,保留 updatedAt 等字段) */
export async function importBackupData(bundle: ParsedBackup, opts: { includeWork: boolean }): Promise<{ work: number, games: number, saves: number }> {
  const counts = { work: 0, games: 0, saves: 0 }
  if (opts.includeWork) {
    await saveWork(bundle.work)
    counts.work = 1
  }
  for (const g of bundle.games) {
    await restoreLocalGame(g)
    counts.games++
  }
  for (const p of bundle.saves) {
    await saveGamePoint(p)
    counts.saves++
  }
  return counts
}

// ---- 云端 API ----

export interface CloudBackupMeta {
  workId: string
  title: string | null
  uploadedAt: string
  workUpdatedAt: string | null
  gameCount: number | null
  messageCount: number | null
  sizeBytes: number | null
}

export async function fetchBackups(): Promise<CloudBackupMeta[]> {
  return await $fetch('/api/backups').catch(() => [])
}

/** 「是否传过」预查:未传过返回 null,已传过返回记录(含上次上传时间) */
export async function fetchBackupMeta(workId: string): Promise<CloudBackupMeta | null> {
  try {
    return await $fetch<CloudBackupMeta>(`/api/backups/${encodeURIComponent(workId)}`)
  } catch (e) {
    if ((e as { status?: number })?.status === 404) return null
    throw e
  }
}

export async function uploadWorkBackup(zip: Uint8Array, meta: WorkBackupMeta): Promise<{ ok: true, uploadedAt: string }> {
  const fd = new FormData()
  fd.append('meta', JSON.stringify(meta))
  // zipSync 产物是完整缓冲的视图,取原 buffer 构建 Blob(避免 Uint8Array<ArrayBufferLike> 与 BlobPart 的类型冲突)
  const buf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
  fd.append('file', new Blob([buf], { type: 'application/zip' }), `${meta.workId}.zip`)
  return await $fetch('/api/backups/upload', { method: 'POST', body: fd })
}

export async function downloadWorkBackup(workId: string): Promise<Uint8Array> {
  const buf = await $fetch<ArrayBuffer>(`/api/backups/${encodeURIComponent(workId)}/download`, { responseType: 'arrayBuffer' })
  return new Uint8Array(buf)
}

export async function deleteCloudBackup(workId: string): Promise<void> {
  await $fetch(`/api/backups/${encodeURIComponent(workId)}`, { method: 'DELETE' })
}
