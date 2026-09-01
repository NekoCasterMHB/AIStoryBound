// app/utils/localDb.ts
// 浏览器本地 IndexedDB(基于 Dexie):角色卡库(worlds)、游戏存档点(saves)、预置小说缓存(presets)
// 与本地小说作品库(works)、本地游戏会话(games)、阅读进度(reading)、导入的 AI Skill(ai-skills)
// 同库,版本升级时按需建仓。仅浏览器端生效(SSR 时由各调用方自行跳过)。
//
// Dexie 自动处理连接管理:收到其他标签页的 versionchange 时默认关闭当前连接让位升级,
// 多标签页不会再互相堵死(旧 idb 实现需手写该补丁)。schema 声明式,新增 store 只需改 stores()。
import Dexie, { type Table } from 'dexie'
import type { CachedPreset, CharacterCard, LocalGame, LocalWork, ReadingProgress } from '#shared/novel'
import type { AiSkill } from '#shared/ai-skills'
import type { ToySettings } from '#shared/toy'
import type { PluginDescriptor } from '#shared/plugin'

export const DB_NAME = 'aiSpankWorld-local'
export const DB_VERSION = 9
export const STORE_WORLDS = 'worlds'
export const STORE_SAVES = 'saves'
export const STORE_PRESETS = 'presets'
export const STORE_WORKS = 'works'
export const STORE_GAMES = 'games'
export const STORE_READING = 'reading'
export const STORE_SKILLS = 'ai-skills'
/** 玩具控制:设备设置(单条记录,key='default') */
export const STORE_TOY_SETTINGS = 'toy-settings'
/** 玩具控制:玩家导入的适配器(manifest + Tier 2 代码,keyPath=id) */
export const STORE_TOY_ADAPTERS = 'toy-adapters'
/** 用户偏好(单条记录,keyPath='key';如叙事速度 key='narr-speed') */
export const STORE_PREFS = 'prefs'
/** 断点续跑:extract 单元提取结果缓存(本地生成管线已移除,表保留兼容旧库数据) */
export const STORE_EXTRACT_CACHE = 'extract-cache'

/** 兼容旧 worlds store 的行结构(旧版按 novelId 存 CharacterCard 数组) */
interface LegacyWorldRow {
  novelId: string
  characters?: CharacterCard[]
}

/** 玩具设备设置行 */
interface ToySettingsRow {
  key: string
  settings?: ToySettings
}

/** 玩家导入的插件行(manifest + 代码) */
export interface ImportedPluginRow {
  id: string
  descriptor: PluginDescriptor
  code?: string
  importedAt: string
}

/** 通用偏好行(如叙事速度 { key: 'narr-speed', cps }) */
export interface PrefsRow {
  key: string
  [k: string]: unknown
}

export class AIStoryBoundDB extends Dexie {
  worlds!: Table<LegacyWorldRow, string>
  saves!: Table<{ key: string } & Record<string, unknown>, string>
  presets!: Table<CachedPreset, string>
  works!: Table<LocalWork, string>
  games!: Table<LocalGame, string>
  reading!: Table<ReadingProgress, string>
  'ai-skills'!: Table<AiSkill, string>
  'toy-settings'!: Table<ToySettingsRow, string>
  'toy-adapters'!: Table<ImportedPluginRow, string>
  prefs!: Table<PrefsRow, string>
  'extract-cache'!: Table<{ key: string } & Record<string, unknown>, string>

  constructor() {
    super(DB_NAME)
    this.version(9).stores({
      [STORE_WORLDS]: 'novelId',
      [STORE_SAVES]: 'key',
      [STORE_PRESETS]: 'id',
      [STORE_WORKS]: 'id',
      [STORE_GAMES]: 'id',
      [STORE_READING]: 'key',
      [STORE_SKILLS]: 'key',
      [STORE_TOY_SETTINGS]: 'key',
      [STORE_TOY_ADAPTERS]: 'id',
      [STORE_PREFS]: 'key',
      [STORE_EXTRACT_CACHE]: 'key'
    })
  }
}

/** 共享 Dexie 实例(单例;versionchange 自动关连接由 Dexie 内置处理) */
export const db = new AIStoryBoundDB()
