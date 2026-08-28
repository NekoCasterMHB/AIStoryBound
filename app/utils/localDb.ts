// app/utils/localDb.ts
// 浏览器本地 IndexedDB(基于 idb)共享连接:角色卡库(worlds)、游戏存档点(saves)、预置小说缓存(presets)
// 与本地小说作品库(works)、本地游戏会话(games)、阅读进度(reading)、导入的 AI Skill(ai-skills)
// 同库,版本升级时按需建仓。仅浏览器端生效(SSR 时由各调用方自行跳过)。
import { openDB } from 'idb'

export const DB_NAME = 'aiSpankWorld-local'
const DB_VERSION = 9
const STORE_WORLDS = 'worlds'
const STORE_SAVES = 'saves'
const STORE_PRESETS = 'presets'
const STORE_WORKS = 'works'
const STORE_GAMES = 'games'
const STORE_READING = 'reading'
const STORE_SKILLS = 'ai-skills'
/** 玩具控制:设备设置(单条记录,key='default') */
export const STORE_TOY_SETTINGS = 'toy-settings'
/** 玩具控制:玩家导入的适配器(manifest + Tier 2 代码,keyPath=id) */
export const STORE_TOY_ADAPTERS = 'toy-adapters'
/** 用户偏好(单条记录,keyPath='key';如叙事速度 key='narr-speed') */
export const STORE_PREFS = 'prefs'
/** 断点续跑:extract 单元提取结果缓存(keyPath='key',见 app/utils/extractCache.ts) */
export const STORE_EXTRACT_CACHE = 'extract-cache'

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
        // v6:用户通过链接导入的 AI Skill(自定义成人玩法,keyPath=key)
        if (!d.objectStoreNames.contains(STORE_SKILLS)) {
          d.createObjectStore(STORE_SKILLS, { keyPath: 'key' })
        }
        // v7:玩具控制——设备设置(单条)与玩家导入的适配器(manifest+代码)
        if (!d.objectStoreNames.contains(STORE_TOY_SETTINGS)) {
          d.createObjectStore(STORE_TOY_SETTINGS, { keyPath: 'key' })
        }
        if (!d.objectStoreNames.contains(STORE_TOY_ADAPTERS)) {
          d.createObjectStore(STORE_TOY_ADAPTERS, { keyPath: 'id' })
        }
        // v8:用户偏好(叙事速度等;单条,keyPath=key)
        if (!d.objectStoreNames.contains(STORE_PREFS)) {
          d.createObjectStore(STORE_PREFS, { keyPath: 'key' })
        }
        // v9:断点续跑——extract 单元提取结果缓存(单条 key=内容摘要)
        if (!d.objectStoreNames.contains(STORE_EXTRACT_CACHE)) {
          d.createObjectStore(STORE_EXTRACT_CACHE, { keyPath: 'key' })
        }
      }
    })
  }
  return dbPromise
}
