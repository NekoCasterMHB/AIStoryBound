// app/utils/localDb.ts
// 浏览器本地 IndexedDB(基于 idb)共享连接:角色卡库(worlds)、游戏存档点(saves)、预置小说缓存(presets)
// 与本地小说作品库(works)、本地游戏会话(games)、阅读进度(reading)同库,版本升级时按需建仓。仅浏览器端生效(SSR 时由各调用方自行跳过)。
import { openDB } from 'idb'

export const DB_NAME = 'aiSpankWorld-local'
const DB_VERSION = 5
const STORE_WORLDS = 'worlds'
const STORE_SAVES = 'saves'
const STORE_PRESETS = 'presets'
const STORE_WORKS = 'works'
const STORE_GAMES = 'games'
const STORE_READING = 'reading'

let dbPromise: Promise<import('idb').IDBPDatabase> | null = null

export function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE_WORLDS)) {
          d.createObjectStore(STORE_WORLDS, { keyPath: 'novelId' })
        }
        if (!d.objectStoreNames.contains(STORE_SAVES)) {
          d.createObjectStore(STORE_SAVES, { keyPath: 'key' })
        }
        if (!d.objectStoreNames.contains(STORE_PRESETS)) {
          d.createObjectStore(STORE_PRESETS, { keyPath: 'id' })
        }
        // v4:本地优先的作品库(章节+实体库+冲突+人物卡概要)与游戏会话(浏览器驱动回合)
        if (!d.objectStoreNames.contains(STORE_WORKS)) {
          d.createObjectStore(STORE_WORKS, { keyPath: 'id' })
        }
        if (!d.objectStoreNames.contains(STORE_GAMES)) {
          d.createObjectStore(STORE_GAMES, { keyPath: 'id' })
        }
        // v5:沉浸式阅读进度(按 key = src:id 存一章)
        if (!d.objectStoreNames.contains(STORE_READING)) {
          d.createObjectStore(STORE_READING, { keyPath: 'key' })
        }
      }
    })
  }
  return dbPromise
}
