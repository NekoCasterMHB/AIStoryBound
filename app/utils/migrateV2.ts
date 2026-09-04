// app/utils/migrateV2.ts
// 一键迁移工具:存量旧 works(v1 LocalWork) → 作品格式 v2(book2)。
// 语义(已定):迁移 = 每部旧 works → workToV2 → 存 book2(同 id)→ 删除旧 works 项(彻底切到 book2)。
// 含  dry-run(列出将迁移/可能失败的项) 与  migrate(可选先生成迁移备份 zip 下载,再转换+删旧)。
import { listWorks, deleteWork } from './worldGen'
import { saveBook2 } from './bookStoreV2'
import { workToV2 } from './v2-convert'
import { zipSync, strToU8 } from 'fflate'
import type { LocalWork } from '#shared/novel'

export interface MigrateItem {
  id: string
  title: string
  ok: boolean
  error?: string
}

export interface MigrateDryRun {
  total: number
  /** 可迁移的作品 */
  items: MigrateItem[]
  /** 因转换失败/缺数据而无法迁移的作品(迁移时跳过,不删除) */
  failures: MigrateItem[]
}

/** 干跑:列出将迁移的作品与可能失败的项(不修改任何数据) */
export async function migrateDryRun(): Promise<MigrateDryRun> {
  const works = await listWorks()
  // 已迁移(book2SourceId 指向自己)的不重复迁移
  const candidates = works.filter(w => !w.book2SourceId || w.book2SourceId !== w.id)
  const items: MigrateItem[] = []
  const failures: MigrateItem[] = []
  for (const w of candidates) {
    try {
      const doc = workToV2(w)
      if (!doc.manifest.title || Object.keys(doc.segments).length === 0) throw new Error('无法生成有效 v2(缺标题或正典)')
      items.push({ id: w.id, title: w.title, ok: true })
    } catch (e) {
      failures.push({ id: w.id, title: w.title, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { total: candidates.length, items, failures }
}

/** 把一组旧 works 打包成 v1 备份 zip(供迁移前下载,失败可回退)。返回 zip 字节。 */
export function buildMigrateBackup(works: LocalWork[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const w of works) {
    entries[`${w.title}-${w.id}.work.json`] = strToU8(JSON.stringify(w, null, 2))
  }
  // 迁移前备份清单
  const manifest = {
    format: 'aisb-migrate-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    kinds: works.map(w => ({ id: w.id, title: w.title }))
  }
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(entries, { level: 6 })
}

/**
 * 执行迁移:每部旧 works → workToV2 → saveBook2(同 id)→ deleteWork。
 * 返回成功/失败明细;failures 已跳过、旧数据保留(不会被误删)。
 */
export async function migrateAllWorksToV2(): Promise<{ migrated: MigrateItem[], failures: MigrateItem[] }> {
  const dry = await migrateDryRun()
  const migrated: MigrateItem[] = []
  const failures: MigrateItem[] = [...dry.failures]

  for (const item of dry.items) {
    try {
      const w = (await listWorks()).find(x => x.id === item.id)
      if (!w) throw new Error('作品已不存在')
      const doc = workToV2(w)
      await saveBook2(doc, w.id)
      await deleteWork(w.id)
      migrated.push({ id: w.id, title: w.title, ok: true })
    } catch (e) {
      failures.push({ id: item.id, title: item.title, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { migrated, failures }
}