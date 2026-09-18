// app/utils/localDb.ts
// 浏览器本地 IndexedDB(基于 Dexie):角色卡库(worlds)、游戏存档点(saves)、预置小说缓存(presets)
// 与本地小说作品库(works)、本地游戏会话(games)、阅读进度(reading)、导入的 AI Skill(ai-skills)
// 同库,版本升级时按需建仓。仅浏览器端生效(SSR 时由各调用方自行跳过)。
//
// Dexie 自动处理连接管理:收到其他标签页的 versionchange 时默认关闭当前连接让位升级,
// 多标签页不会再互相堵死(旧 idb 实现需手写该补丁)。schema 声明式,新增 store 只需改 stores()。
import Dexie, { type Table } from 'dexie'
import type { CachedPreset, CharacterCard, LocalGameRow, LocalWork, ReadingProgress } from '#shared/novel'
import type { AiSkill } from '#shared/ai-skills'
import type { ToySettings } from '#shared/toy'
import type { PluginDescriptor } from '#shared/plugin'
import type { AisbBookManifest, BookCharacter, BookGame, BookWorld, SegmentCanon, SegmentCharacterFile } from '#shared/novel-v2'

export const DB_NAME = 'aiSpankWorld-local'
export const DB_VERSION = 14
export const STORE_WORLDS = 'worlds'
export const STORE_SAVES = 'saves'
export const STORE_PRESETS = 'presets'
export const STORE_WORKS = 'works'
/** v1 作品计量旁路(游玩消耗小行):works 行带全部章节正文,v1 遗留层同享 v14 拆分收益 */
export const STORE_WORKS_META = 'works-meta'
export const STORE_GAMES = 'games'
export const STORE_GAME_MESSAGES = 'game-messages'
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
/** 作品格式 v2(aisb-book)原生存储:结构化表族(zip 只在导入/导出/备份边界序列化) */
export const STORE_BOOKS = 'books'
export const STORE_BOOK_TEXTS = 'book-texts'
export const STORE_BOOK_SEGMENTS = 'book-segments'
export const STORE_BOOK_SEG_CHARS = 'book-seg-chars'
export const STORE_BOOK_CHARACTERS = 'book-characters'
export const STORE_BOOK_WORLD = 'book-world'
/** v2 作品高频标量(游玩消耗累计):与 books 行分离——IndexedDB 无部分更新,
 *  每回合 AI 调用记账若 update books 行会整本 fulltext 搬移;本表行仅几十字节 */
export const STORE_BOOK_STATS = 'book-stats'

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
  games!: Table<LocalGameRow, string>
  reading!: Table<ReadingProgress, string>
  'ai-skills'!: Table<AiSkill, string>
  'toy-settings'!: Table<ToySettingsRow, string>
  'toy-adapters'!: Table<ImportedPluginRow, string>
  prefs!: Table<PrefsRow, string>
  'extract-cache'!: Table<{ key: string } & Record<string, unknown>, string>
  books!: Table<BookMetaRow, string>
  'book-texts'!: Table<BookTextRow, string>
  'book-segments'!: Table<BookSegmentRow, [string, number]>
  'book-seg-chars'!: Table<BookSegCharRow, string>
  'book-characters'!: Table<BookCharacterRow, [string, string]>
  'book-world'!: Table<BookWorldRow, string>
  'book-stats'!: Table<BookStatsRow, string>
  'game-messages'!: Table<LocalGameMessageRow, [string, number]>

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
    // v13:books 行拆出高频标量表 book-stats(游玩消耗累计)。迁移:存量 books.tokensUsed
    // 复制进 stats 行;books 行内旧字段不清洗,由下次整行自然写入时脱落(saveBookDoc 不再写它)
    this.version(13).stores({
      ...this.version(12).stores,
      [STORE_BOOK_STATS]: 'id'
    }).upgrade(async (tx) => {
      // 游标逐行 + 行级防御:单行畸形不中止整个升级(库打不开的后果远大于漏一行计量)
      const books = tx.table(STORE_BOOKS) as Table<BookMetaRow, string>
      const stats = tx.table(STORE_BOOK_STATS) as Table<BookStatsRow, string>
      await books.each(async (row) => {
        try {
          if (typeof row.tokensUsed === 'number' && row.tokensUsed > 0) {
            await stats.put({ id: row.id, tokensUsed: row.tokensUsed })
          }
        } catch {
          // 单行迁移失败忽略
        }
      })
    })
    // v14:大字段原子化——「动一处重写一片」根除。
    //  ① books.fulltext → book-texts(meta 行不再扛整本正文,touch/charCount 写入变 KB 级);
    //  ② 段行三拆:canon.text → book-texts,角色文件 map → book-seg-chars(改一个角色文件
    //     = 一行 put,不再搬段正文与同段其他角色),段行只留 canon;
    //  ③ games.messages → game-messages(append-only 一消息一行,每回合 persist 不再 O(局史)),
    //     optionsByMessage 留在 games 行(已被裁剪有界);saves 存档点去 messages
    //     (消息表只追加,水位线语义下回滚所需消息 ⊆ 当前表,丢快照拷贝无损);新增 games.msgCount;
    //  ④ 零引用死表 worlds / extract-cache 删除;
    //  ⑤ works 加 sourceTaskId 索引(按云端任务查已安装作品不再全表扫描)。
    this.version(14).stores({
      ...this.version(13).stores,
      [STORE_BOOK_TEXTS]: 'key, id',
      [STORE_BOOK_SEG_CHARS]: 'key, id',
      [STORE_GAME_MESSAGES]: '[gameId+idx], gameId',
      [STORE_WORKS]: 'id, sourceTaskId',
      [STORE_WORKS_META]: 'id',
      [STORE_WORLDS]: null,
      [STORE_EXTRACT_CACHE]: null
    }).upgrade(async (tx) => {
      // 游标逐行 + 行级防御:books→texts、segments 三拆、games→messages、saves 剥快照;
      // 单行畸形跳过不中止升级(canon 缺失的退化行整行跳过,避免产出无 index 的脏行)
      const books = tx.table(STORE_BOOKS) as Table<BookMetaRow & { fulltext?: string }, string>
      const texts = tx.table(STORE_BOOK_TEXTS) as Table<BookTextRow, string>
      const segs = tx.table(STORE_BOOK_SEGMENTS) as Table<BookSegmentRow, [string, number]>
      const segChars = tx.table(STORE_BOOK_SEG_CHARS) as Table<BookSegCharRow, string>
      const games = tx.table(STORE_GAMES) as Table<LocalGameRow, string>
      const gameMsgs = tx.table(STORE_GAME_MESSAGES) as Table<LocalGameMessageRow, [string, number]>
      const saves = tx.table(STORE_SAVES) as Table<GameSavePointRow, string>
      interface RawMsg { id: string, idx: number, role: string, speaker: string | null, content: string }
      await books.each(async (row) => {
        try {
          if (typeof row.fulltext !== 'string') return
          await texts.put({ key: bookFullTextKey(row.id), id: row.id, text: row.fulltext })
          const { fulltext: _drop, ...meta } = row
          await books.put(meta as BookMetaRow)
        } catch { /* 单行失败忽略 */ }
      })
      await segs.each(async (row) => {
        try {
          if (!row?.canon || typeof row.canon.index !== 'number') return // 退化/畸形行:整行跳过
          const { characters: chars, canon } = row as BookSegmentRow & { characters?: Record<string, unknown> }
          if (typeof canon.text === 'string' && canon.text) {
            await texts.put({ key: bookSegTextKey(row.id, row.seq), id: row.id, text: canon.text })
          }
          for (const [name, file] of Object.entries(chars ?? {})) {
            try {
              await segChars.put({ key: bookSegCharKey(row.id, row.seq, name), id: row.id, seq: row.seq, name, file: file as SegmentCharacterFile })
            } catch { /* 单文件失败忽略 */ }
          }
          await segs.put({ id: row.id, seq: row.seq, key: row.key, canon: { ...canon, text: '' } })
        } catch { /* 单段失败忽略 */ }
      })
      await games.each(async (g) => {
        try {
          const msgs = ((g as LocalGameRow & { messages?: RawMsg[] }).messages) ?? []
          for (const m of msgs) {
            if (typeof m.idx !== 'number' || !m.id) continue // 缺主键成分的消息行跳过
            await gameMsgs.put({ gameId: g.id, idx: m.idx, msgId: m.id, role: m.role, speaker: m.speaker, content: m.content })
          }
          const { messages: _msgs, ...rest } = g as LocalGameRow & { messages?: RawMsg[] }
          await games.put({ ...rest, msgCount: msgs.length })
        } catch { /* 单局失败忽略 */ }
      })
      await saves.each(async (sv) => {
        try {
          if (!('messages' in sv)) return
          const { messages: _m, ...rest } = sv
          await saves.put(rest as GameSavePointRow)
        } catch { /* 单行失败忽略 */ }
      })
    })
  }
}

// v10 遗留常量:v11 已删除该表,保留常量仅为旧导入引用兼容
export const STORE_BOOK2 = 'book2'

/** v2 作品元数据行(books 表;小行,正文大字段已拆 book-texts,touch/charCount 更新为 KB 级写入) */
export interface BookMetaRow {
  id: string
  title: string
  author?: string
  updatedAt: string
  /** @deprecated 已拆到 book-stats 表;旧行残留字段由下次整行写入自然脱落 */
  tokensUsed?: number
  /** manifest 完整 JSON(format/version/kind/segmentCount/charCount/概览扩展字段) */
  manifest: AisbBookManifest
  /** 归档正文字符数(texts:false 窄读取时书架展示/空正文判定用) */
  textChars?: number
  /** 分享 kind=game 包导入时附带的游戏会话(罕见,可空) */
  games?: Record<string, BookGame>
}

/** v2 正文大字段行(book-texts 表;key = `${bookId}::full` 归档全文 / `${bookId}::seg::${seq}` 段正文)。
 *  与元数据/正典分离:改 meta、改段角色文件都不再搬动正文,正文编辑也只动单行 */
export interface BookTextRow {
  key: string
  id: string
  text: string
}

/** book-texts 键:归档全文 */
export function bookFullTextKey(bookId: string): string {
  return `${bookId}::full`
}

/** book-texts 键:段正文(seq 为段序) */
export function bookSegTextKey(bookId: string, seq: number): string {
  return `${bookId}::seg::${seq}`
}

/** v2 作品高频标量行(book-stats 表;每回合 AI 记账只读写本行,不搬 books 全行) */
export interface BookStatsRow {
  id: string
  /** 游玩消耗累计(不进 zip,备份恢复后归零) */
  tokensUsed?: number
}

/** v2 剧情段行(book-segments 表;canon 元数据,正文已拆 book-texts) */
export interface BookSegmentRow {
  id: string
  /** 段序(0-based;排序用) */
  seq: number
  /** 段文件夹名(如 '000';与 zip 内目录名一致) */
  key: string
  canon: SegmentCanon
}

/** v2 段角色文件行(book-seg-chars 表;原子粒度:改一个角色的一份段文件 = 单行 put) */
export interface BookSegCharRow {
  /** `${bookId}::${seq}::${name}` */
  key: string
  id: string
  seq: number
  name: string
  file: SegmentCharacterFile
}

/** book-seg-chars 键 */
export function bookSegCharKey(bookId: string, seq: number, name: string): string {
  return `${bookId}::${seq}::${name}`
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

/** 游玩消息行(game-messages 表;append-only,一消息一行,主键 [gameId+idx])。
 *  与 games 行分离:每回合 persist 只 append 新消息,不再整局重写 */
export interface LocalGameMessageRow {
  gameId: string
  /** 消息序号(局内递增;回滚即删除 idx 大于水位线的行) */
  idx: number
  /** 消息 id(与 LocalGame.messages[].id 一致;选项键、回滚菜单都用它) */
  msgId: string
  role: string
  speaker: string | null
  content: string
}

/** games 行的消息数(列表页「N 条剧情」;消息本体在 game-messages 表) */
export interface GameRowCounts {
  msgCount?: number
}

/** 存档点行(v14 起 messages 字段已废弃删除:消息表只追加,回滚所需消息 ⊆ 当前表) */
export interface GameSavePointRow {
  key: string
  gameId: string
  idx: number
  state?: unknown
  currentBeat?: number | null
  reinject?: unknown
  summary?: unknown
  savedAt: string
}

/** 共享 Dexie 实例(单例;versionchange 自动关连接由 Dexie 内置处理) */
export const db = new AIStoryBoundDB()

// ---- 写入边界消毒:IDB 结构化克隆拒绝一切 Vue reactive Proxy(ref()/reactive() 的深层包装,
// 实测连扁平代理都无法克隆,存档/设置/消息行只要带一个代理字段整行写入即抛 DataCloneError)。
// 在 Table 原型上统一把写入值深度转纯数据(JSON 往返;库内值域全是纯 JSON),put/add/bulkPut/
// update 的所有调用点(现有与未来)自动免疫,不再逐调用点手工 JSON.clone。 ----
function plainForWrite<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

{
  const writeProto = Object.getPrototypeOf(db.table(STORE_GAMES)) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const method of ['put', 'add', 'bulkPut', 'update'] as const) {
    const raw = writeProto[method]
    if (typeof raw !== 'function') continue
    writeProto[method] = function (this: unknown, ...args: unknown[]) {
      // update(键, 变更)消毒变更对象;其余方法首参为写入值(键为主键字符串/数组,原样透传)
      if (method === 'update') {
        if (args[1] != null) args[1] = plainForWrite(args[1])
      } else if (args[0] != null) {
        args[0] = plainForWrite(args[0])
      }
      return raw.apply(this, args)
    }
  }
}
