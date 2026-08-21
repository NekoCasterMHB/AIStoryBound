// app/utils/localDb.ts
// 浏览器本地 IndexedDB(基于 idb)共享连接:角色卡库(worlds)与游戏存档点(saves)同库,
// 版本升级时按需建仓。仅浏览器端生效(SSR 时由各调用方自行跳过)。
import { openDB } from 'idb'

export const DB_NAME = 'aistorybound-local'
const DB_VERSION = 2
const STORE_WORLDS = 'worlds'
const STORE_SAVES = 'saves'

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
      }
    })
  }
  return dbPromise
}
