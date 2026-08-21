// app/utils/characterStore.ts
// 本地 IndexedDB 存取(基于 idb):上传生成的人物卡/世界观保存到浏览器本地,
// 作为"我的世界"本地库后端使用。仅浏览器端生效(SSR 时自动跳过)。
import type { CharacterCard } from '../../shared/novel'
import { db } from './localDb'

const STORE = 'worlds'

export interface SavedWorld {
  novelId: string
  title: string
  genre?: string
  summary?: string
  /** 人物卡数组(来源可能字段不全,读取时按需访问) */
  characters: Array<Partial<CharacterCard> & { name: string }>
  savedAt: string
}

/** 保存一本小说的人物卡/世界观到本地(按 novelId 覆盖) */
export async function saveWorld(world: SavedWorld): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  // 入库存纯数据:调用方可能传入 Vue reactive proxy,结构化克隆会抛 DataCloneError
  await d.put(STORE, JSON.parse(JSON.stringify(world)))
}

/** 按 novelId 读取本地人物卡;不存在返回 undefined */
export async function getWorld(novelId: string): Promise<SavedWorld | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  const d = await db()
  return d.get(STORE, novelId)
}

/** 列出本地已保存的全部人物卡(按保存时间倒序) */
export async function listWorlds(): Promise<SavedWorld[]> {
  if (typeof indexedDB === 'undefined') return []
  const d = await db()
  const all = await d.getAll(STORE)
  return all.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''))
}

/** 删除本地人物卡 */
export async function deleteWorld(novelId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.delete(STORE, novelId)
}