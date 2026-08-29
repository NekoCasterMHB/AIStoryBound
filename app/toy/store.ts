// app/toy/store.ts
// 玩具控制的本地持久化:设备设置(硬限制/总开关)与玩家导入的插件清单。
// 全部存 IndexedDB(不经过服务端:执行路径在浏览器,设置只对本地生效)。
// SSR/非浏览器环境一律返回默认值或空列表。
import { DEFAULT_TOY_SETTINGS } from '#shared/toy'
import type { ToySettings } from '#shared/toy'
import type { PluginDescriptor } from '#shared/plugin'
import { db, STORE_TOY_ADAPTERS, STORE_TOY_SETTINGS } from '../utils/localDb'

const SETTINGS_KEY = 'default'

// ---- 设备设置 ----

export async function loadToySettings(): Promise<ToySettings> {
  if (typeof indexedDB === 'undefined') return { ...DEFAULT_TOY_SETTINGS }
  const row = await db.table(STORE_TOY_SETTINGS).get(SETTINGS_KEY) as { settings?: ToySettings } | undefined
  // 与默认值合并:新版本新增字段时旧存档自动补全
  const stored = (row?.settings ?? {}) as ToySettings
  return { ...DEFAULT_TOY_SETTINGS, ...stored }
}

export async function saveToySettings(settings: ToySettings): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_TOY_SETTINGS).put({ key: SETTINGS_KEY, settings })
}

// ---- 玩家导入的插件(新版 PluginDescriptor 格式) ----

export interface ImportedPluginRecord {
  id: string
  descriptor: PluginDescriptor
  /** Tier 2 适配器代码(纯函数 buildFrames 等;Worker 沙箱执行) */
  code?: string
  importedAt: string
}

export async function listImportedAdapters(): Promise<ImportedPluginRecord[]> {
  if (typeof indexedDB === 'undefined') return []
  return (await db.table(STORE_TOY_ADAPTERS).toArray())
    // 只认新版记录(descriptor 结构);旧格式记录忽略(放弃旧版兼容)
    .filter((r): r is ImportedPluginRecord => !!r && typeof r === 'object' && !!(r as ImportedPluginRecord).descriptor)
    .sort((a, b) => a.importedAt.localeCompare(b.importedAt))
}

export async function getImportedAdapter(id: string): Promise<ImportedPluginRecord | null> {
  if (typeof indexedDB === 'undefined') return null
  const r = await db.table(STORE_TOY_ADAPTERS).get(id)
  return r && typeof r === 'object' && (r as ImportedPluginRecord).descriptor ? r as ImportedPluginRecord : null
}

export async function saveImportedAdapter(record: ImportedPluginRecord): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_TOY_ADAPTERS).put(record)
}

export async function deleteImportedAdapter(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_TOY_ADAPTERS).delete(id)
}

/** 清空旧格式导入记录(放弃旧版兼容;新格式仅 descriptor 结构) */
export async function clearLegacyImportedAdapters(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const all = await db.table(STORE_TOY_ADAPTERS).toArray()
  for (const r of all) {
    if (!r || typeof r !== 'object' || !(r as ImportedPluginRecord).descriptor) {
      await db.table(STORE_TOY_ADAPTERS).delete((r as { id?: string })?.id ?? '')
    }
  }
}
