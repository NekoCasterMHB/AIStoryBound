// shared/share-format.ts
// 分享包格式标识(客户端 shareZip.ts 与服务端成书下载打包共用;导入端必须匹配)
export const SHARE_FORMAT = 'aisb-share'
export const SHARE_VERSION = 1

// ---- 作品整包备份(书架「同步云端」:作品+游戏会话+存盘点打包上传 R2) ----
// 与 SHARE_FORMAT 分开:旧分享导入器(只还原作品)不能误吞备份包,反之亦然
export const BACKUP_FORMAT = 'aisb-backup'
export const BACKUP_VERSION = 1

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: number
  kind: 'work-backup'
  workId: string
  exportedAt: string
  gameCount: number
}

/** 备份包 ZIP 条目(打包端/解包端共用,避免键名漂移) */
export const BACKUP_ENTRIES = {
  manifest: 'manifest.json',
  work: 'work.json',
  games: 'games.json',
  saves: 'saves.json'
} as const
