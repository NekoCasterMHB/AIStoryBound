// app/toy/store.ts
// 玩具控制的本地持久化:设备设置(硬限制/总开关)与玩家导入的适配器。
// 全部存 IndexedDB(不经过服务端:执行路径在浏览器,设置只对本地生效)。
// SSR/非浏览器环境一律返回默认值或空列表。
import { DEFAULT_TOY_SETTINGS } from '#shared/toy'
import type { ToyAdapterManifest, ToySettings } from '#shared/toy'
import { db, STORE_TOY_ADAPTERS, STORE_TOY_SETTINGS } from '../utils/localDb'

const SETTINGS_KEY = 'default'

// ---- 设备设置 ----

export async function loadToySettings(): Promise<ToySettings> {
  if (typeof indexedDB === 'undefined') return { ...DEFAULT_TOY_SETTINGS }
  const d = await db()
  const row = await d.get(STORE_TOY_SETTINGS, SETTINGS_KEY) as { settings?: ToySettings } | undefined
  // 与默认值合并:新版本新增字段时旧存档自动补全
  return { ...DEFAULT_TOY_SETTINGS, ...(row?.settings ?? {}) }
}

export async function saveToySettings(settings: ToySettings): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.put(STORE_TOY_SETTINGS, { key: SETTINGS_KEY, settings })
}

// ---- 玩家导入的适配器 ----

export interface ImportedToyAdapterRecord {
  id: string
  manifest: ToyAdapterManifest
  /** Tier 2 适配器代码(纯函数 buildFrames 等;Worker 沙箱执行) */
  code?: string
  importedAt: string
}

export async function listImportedAdapters(): Promise<ImportedToyAdapterRecord[]> {
  if (typeof indexedDB === 'undefined') return []
  const d = await db()
  return (await d.getAll(STORE_TOY_ADAPTERS)).sort((a, b) => a.importedAt.localeCompare(b.importedAt))
}

export async function getImportedAdapter(id: string): Promise<ImportedToyAdapterRecord | null> {
  if (typeof indexedDB === 'undefined') return null
  const d = await db()
  return (await d.get(STORE_TOY_ADAPTERS, id)) ?? null
}

export async function saveImportedAdapter(record: ImportedToyAdapterRecord): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.put(STORE_TOY_ADAPTERS, record)
}

export async function deleteImportedAdapter(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.delete(STORE_TOY_ADAPTERS, id)
}
