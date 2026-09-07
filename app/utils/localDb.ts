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
import type { AisbBookManifest, BookCharacter, BookGame, BookWorld, SegmentCanon, SegmentCharacterFile } from '#shared/novel-v2'

export const DB_NAME = 'aiSpankWorld-local'
export const DB_VERSION = 12
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
/** 作品格式 v2(aisb-book)原生存储:结构化四表(zip 只在导入/导出/备份边界序列化) */
export const STORE_BOOKS = 'books'
export const STORE_BOOK_SEGMENTS = 'book-segments'
export const STORE_BOOK_CHARACTERS = 'book-characters'
export const STORE_BOOK_WORLD = 'book-world'

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
  books!: Table<BookMetaRow, string>
  'book-segments'!: Table<BookSegmentRow, [string, number]>
  'book-characters'!: Table<BookCharacterRow, [string, string]>
  'book-world'!: Table<BookWorldRow, string>

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
    this.version(10).stores({
      ...this.version(9).stores,
      [STORE_BOOK2]: 'id'
    })
    // v11:v2 存储原生化——book2 单表 zip 行删除(未上线,无存量迁移),拆为结构化四表:
    // 修改一张人物卡/一段正典 = 重写对应行,读取按需查表,zip 只在导入/导出/备份边界序列化
    this.version(11).stores({
      ...this.version(10).stores,
      [STORE_BOOK2]: null,
      [STORE_BOOKS]: 'id, updatedAt',
      [STORE_BOOK_SEGMENTS]: '[id+seq], id',
      [STORE_BOOK_CHARACTERS]: '[id+name], id',
      [STORE_BOOK_WORLD]: 'id'
    })
    // v12:saves 加 gameId 索引——存档点按局查询/清理(capGamePoints 每回合调用)不再全表扫描
    this.version(12).stores({
      ...this.version(11).stores,
      [STORE_SAVES]: 'key, gameId'
    })
  }
}

// v10 遗留常量:v11 已删除该表,保留常量仅为旧导入引用兼容
export const STORE_BOOK2 = 'book2'

/** v2 作品元数据行(books 表;fulltext 归档随行,修改频率低) */
export interface BookMetaRow {
  id: string
  title: string
  author?: string
  updatedAt: string
  /** 游玩消耗累计(行级字段,游玩时增量更新;不进 zip,备份恢复后归零) */
  tokensUsed?: number
  /** manifest 完整 JSON(format/version/kind/segmentCount/charCount/概览扩展字段) */
  manifest: AisbBookManifest
  /** 归档全文(仅阅读用,不入逻辑;逻辑正文在段正典) */
  fulltext: string
  /** 分享 kind=game 包导入时附带的游戏会话(罕见,可空) */
  games?: Record<string, BookGame>
}

/** v2 剧情段行(book-segments 表;key 为段文件夹名如 '000') */
export interface BookSegmentRow {
  id: string
  /** 段序(0-based;排序用) */
  seq: number
  /** 段文件夹名(如 '000';与 zip 内目录名一致) */
  key: string
  canon: SegmentCanon
  /** 该段有可用状态/剧情的角色文件(key=姓名) */
  characters: Record<string, SegmentCharacterFile>
}

/** v2 基础人物卡行(book-characters 表;编辑按卡保存) */
export interface BookCharacterRow {
  id: string
  name: string
  card: BookCharacter
}

/** v2 引擎派生数据行(book-world 表;单作品一行) */
export interface BookWorldRow {
  id: string
  world?: BookWorld
}

/** 共享 Dexie 实例(单例;versionchange 自动关连接由 Dexie 内置处理) */
export const db = new AIStoryBoundDB()
