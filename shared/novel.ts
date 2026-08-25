// shared/novel.ts
// AI SpankWorld 共享类型与工具(不依赖运行时,前后端/服务端均可引用)

/** 小说解析状态 */
export type NovelStatus = 'uploaded' | 'parsing' | 'ready' | 'failed'

/** 小说实体(D1 novels 行) */
export interface NovelRow {
  id: string
  user_id: string | null
  title: string
  author: string | null
  source_format: string
  storage_key: string | null
  encoding: string | null
  chapter_count: number
  status: NovelStatus
  parse_progress: number
  world_state: string | null
  error: string | null
  created_at: string
}

/** 章节切分结果 */
export interface ChapterSegment {
  title: string
  content: string
}

/** 预置小说实体(D1 preset_novels 行,正文存 R2 storage_key) */
export interface PresetNovelRow {
  id: string
  title: string
  author: string | null
  genre: string | null
  description: string | null
  cover_emoji: string | null
  storage_key: string | null
  encoding: string | null
  chapter_count: number
  char_count: number
  /** 1=首页推荐 */
  featured: number
  sort_order: number
  download_count: number
  created_at: string | null
}

/** 预置小说缓存条目(浏览器 IndexedDB presets store) */
export interface CachedPreset {
  id: string
  meta: Pick<PresetNovelRow, 'id' | 'title' | 'author' | 'genre' | 'description' | 'cover_emoji'>
  text: string
  size: number
  savedAt: string
}

/**
 * 人物卡(规划 §5.1 Characters + §6 Character Card)。
 * 由 LLM 在小说解析阶段生成,存于 novels.world_state 的 characters 数组。
 */
export interface CharacterCard {
  name: string
  /** 主角 / 配角 / 反派 */
  role: string
  /** 别名 */
  alias?: string | null
  gender?: string | null
  /** 年龄允许模糊表达,如"约40岁""未知" */
  age?: string | null
  /** 身份 / 职业,如"警察""天文学家" */
  identity?: string | null
  /** 外貌描写 */
  appearance?: string | null
  /** 性格特征 */
  personality: string[]
  /** 说话风格 */
  speech_style?: string[]
  /** 背景故事 */
  background?: string | null
  /** 能力 / 特殊技能 */
  abilities?: string[]
  goals?: string[]
  fears?: string[]
  secrets?: string[]
  /** 人物关系:name=对方、type=关系类型、value=-100..100 的亲密度 */
  relationships?: { name: string, type: string, value: number }[]
  /** 首次出现章节 */
  first_appearance?: string | null
  dead?: boolean | null
  /** 耐心程度,0-100 整数(数值越小越急躁,影响 AI 演绎的对话风格) */
  patience?: number | null
  /** 心软程度,0-100 整数(数值越大越容易心软妥协) */
  softness?: number | null
}

/** 世界观速览(规划 §5),整体存于 novels.world_state */
export interface WorldOverlay {
  title?: string
  genre?: string
  summary?: string
  characters?: CharacterCard[]
}

// ---- 世界观生成流水线(浏览器本地编排 + 服务器 AI 中继;实体库/冲突仅存 IndexedDB) ----

/** 单条溯源:出现章节号 + 原文引用(quote 由模型逐字摘录,verified 由代码比对章节原文标记) */
export interface EntitySource {
  chapter: number
  quote?: string | null
  verified?: boolean
}

/** 单章(或超长章的一段)提取的人物锚点 */
export interface ExtractedCharacter {
  name: string
  alias?: string[]
  gender?: string | null
  age?: string | null
  identity?: string | null
  appearance?: string | null
  personality?: string[]
  speech_style?: string[]
  background?: string | null
  abilities?: string[]
  goals?: string[]
  fears?: string[]
  secrets?: string[]
  relationships?: { name: string, type: string }[]
  dead?: boolean | null
  quote?: string | null
}

export interface ExtractedLocation {
  name: string
  type?: string | null
  description?: string | null
  notable?: string[]
  quote?: string | null
}

export interface ExtractedFaction {
  name: string
  description?: string | null
  goal?: string | null
  members?: string[]
  quote?: string | null
}

export interface ExtractedTimelineEvent {
  time?: string | null
  event: string
  characters_involved?: string[]
  quote?: string | null
}

export interface ExtractedWorldRule {
  category?: string | null
  rule: string
  quote?: string | null
}

export interface ExtractedItem {
  name: string
  description?: string | null
  significance?: string | null
  quote?: string | null
}

export interface ExtractedForeshadow {
  hint: string
  quote?: string | null
}

/** 一个提取单元(一章或超长章节的一段)输出的结构化结果 */
export interface ChapterExtraction {
  characters: ExtractedCharacter[]
  locations: ExtractedLocation[]
  factions: ExtractedFaction[]
  timeline_events: ExtractedTimelineEvent[]
  world_rules: ExtractedWorldRule[]
  items: ExtractedItem[]
  foreshadowing: ExtractedForeshadow[]
}

/** 合并后的实体(Merge 阶段产物,sources 携带全文溯源) */
export interface MergedCharacter extends ExtractedCharacter {
  sources: EntitySource[]
  mentionCount: number
}
export interface MergedLocation extends ExtractedLocation {
  sources: EntitySource[]
  mentionCount: number
}
export interface MergedFaction extends ExtractedFaction {
  sources: EntitySource[]
  mentionCount: number
}
export interface MergedTimelineEvent extends ExtractedTimelineEvent {
  sources: EntitySource[]
  mentionCount: number
}
export interface MergedWorldRule extends ExtractedWorldRule {
  sources: EntitySource[]
  mentionCount: number
}
export interface MergedItem extends ExtractedItem {
  sources: EntitySource[]
  mentionCount: number
}
export interface MergedForeshadow extends ExtractedForeshadow {
  sources: EntitySource[]
  mentionCount: number
}

export interface WorldEntities {
  characters: MergedCharacter[]
  locations: MergedLocation[]
  factions: MergedFaction[]
  timeline_events: MergedTimelineEvent[]
  world_rules: MergedWorldRule[]
  items: MergedItem[]
  foreshadowing: MergedForeshadow[]
}

/** 冲突裁决倾向(一致性检查标注;代码合并默认"后文为准") */
export type ConflictVerdict = 'later_wins' | 'first_wins' | 'uncertain' | 'not_conflict'

/** 设定冲突:合并阶段代码发现(带双证据)/ AI 检查补充 */
export interface EntityConflict {
  id: string
  entityType: string
  entityName: string
  field: string
  valueA?: string | boolean | number | null
  valueB?: string | boolean | number | null
  evidenceA?: EntitySource | null
  evidenceB?: EntitySource | null
  verdict?: ConflictVerdict
  reason?: string | null
  source?: 'merge' | 'ai_check'
}

// ---- 沉浸式阅读(本地 IndexedDB reading store;不跨设备同步) ----

/** 阅读背景主题 */
export type ReaderTheme = 'green' | 'sepia' | 'night' | 'light'

/** 阅读偏好设置(随进度一起持久化) */
export interface ReaderSettings {
  theme: ReaderTheme
  /** 正文字号 px */
  fontSize: number
  /** 行距倍数 */
  lineHeight: number
  /** 正文字体:serif=衬线(宋体风格), sans=黑体, system=跟随系统 */
  font: 'serif' | 'sans' | 'system'
  /** 工具栏自动隐藏(关=始终显示;开=轻点屏幕呼出并超时自动收起) */
  autohide: boolean
  /** 翻页模式:scroll=滚动滑动(默认);tap=点击分区分页(左半区上一页/右半区下一页,章节内滚动一屏) */
  pageMode: 'scroll' | 'tap'
  /** 长按自动滚动(长按正文自动向下滚动,松手停止) */
  autoScroll: boolean
  /** 自动滚动速度挡位 1~5(数值越大越快) */
  autoScrollSpeed: number
  /** 自定义背景色(hex;设置后覆盖内置主题底色) */
  customBg?: string
  /** 自定义正文颜色(hex;设置后覆盖内置主题文字色) */
  customText?: string
  /** 自定义背景图(压缩后的 dataURL,存本机 IndexedDB;优先级高于背景色) */
  bgImage?: string
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: 'sepia',
  fontSize: 18,
  lineHeight: 1.8,
  font: 'system',
  autohide: false,
  pageMode: 'scroll',
  autoScroll: false,
  autoScrollSpeed: 3
}

export const READER_FONT_SIZES = [14, 16, 18, 20, 22, 24] as const
export const READER_LINE_HEIGHTS = [1.4, 1.8, 2.2, 2.6] as const

/** 阅读进度(IndexedDB reading store,key = `${src}:${id}`) */
export interface ReadingProgress {
  key: string
  src: 'preset' | 'work'
  id: string
  title: string
  /** 当前章节下标 */
  chapterIndex: number
  /** 本章内滚动位置 0-1 */
  scrollRatio: number
  settings: ReaderSettings
  /** 是否已读到末章末尾(全书完) */
  finished: boolean
  updatedAt: string
}

/** 阅读进度 key(src 区分预置小说与本地作品) */
export function readingKey(src: 'preset' | 'work', id: string): string {
  return `${src}:${id}`
}

// ---- 本地优先数据(IndexedDB;云仅同步作品结果与游戏快照,不含章节正文) ----

/** 本地小说作品:章节正文 + 生成产物 */
export interface LocalWork {
  id: string
  title: string
  author?: string
  createdAt: string
  /** 最后操作时间(浏览/编辑/游戏游玩时刷新;旧数据缺失时卡片回退用 createdAt) */
  updatedAt?: string
  chapters: ChapterSegment[]
  encoding?: string
  /** syncStatus: synced=云端已有对应 novels 行 */
  syncStatus: 'local' | 'synced' | 'dirty'
  /** 生成消耗的平台 token 总量(展示用;AI 配置走用户 key 时为 0) */
  tokensUsed?: number
  /** 生成产物(entities/conflicts/overlay 一起生成,一起保存) */
  entities?: WorldEntities
  conflicts?: EntityConflict[]
  warnings?: string[]
  overlay?: {
    title?: string
    genre?: string
    summary?: string
    characters?: CharacterCard[]
  }
}

/** 本地游戏会话(浏览器驱动回合,本地落盘;登录用户可手动同步云端) */
export interface LocalGame {
  id: string
  workId: string
  playerName: string
  characterName: string
  state: GameState
  messages: { id: string, idx: number, role: string, speaker: string | null, content: string }[]
  /** 每条旁白消息挂载的选项(回合结束后生成,回滚时一并恢复) */
  optionsByMessage?: Record<string, { idx: number, text: string }[]>
  currentChapter?: string | null
  summary?: { idx: number, text: string } | null
  status: 'active' | 'ended'
  createdAt: string
  updatedAt: string
  syncStatus: 'local' | 'synced' | 'dirty'
}

/** LLM 用量统计 */
export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

// ---- 游戏(浏览器本地为真源,D1 仅云端同步镜像) ----

/** 游戏模式 */
export type GameMode = 'canonical'

/** 游戏状态(规划 §10/§33:地点/时间/身体状况/心情/关系/任务/Flag;内部状态不进回复文本) */
export interface GameState {
  location?: string
  time?: string
  /** 身体状况描述(如「精力充沛」「疲惫不堪」) */
  health?: string
  /** 心情描述(如「平静」「忐忑不安」) */
  mood?: string
  /** 角色名 -> 好感度(-100..100) */
  relationships?: Record<string, number>
  quests?: string[]
  flags?: Record<string, boolean | string | number>
  /** AI 内部状态(不展示给玩家,仅进 prompt) */
  internal?: Record<string, unknown>
}

export type GameStatus = 'active' | 'ended'

/** 游戏会话(D1 games 行) */
export interface GameRow {
  id: string
  novel_id: string | null
  user_id: string | null
  player_character_id: string | null
  player_character_name: string | null
  mode: string | null
  current_chapter: string | null
  status: string | null
  summary: string | null
  state: string | null
  created_at: string
  updated_at: string | null
}

/** 消息角色:narrator=旁白/剧情, character=角色台词, user=玩家, system=系统 */
export type MessageRole = 'narrator' | 'character' | 'user' | 'system'

/** 游戏消息(D1 game_messages 行) */
export interface GameMessageRow {
  id: string
  game_id: string | null
  idx: number
  role: string
  speaker: string | null
  content: string
  created_at: string
}

/** 一轮选项(D1 game_options 行) */
export interface GameOptionRow {
  id: string
  game_id: string | null
  message_id: string | null
  idx: number
  text: string
  effects: string | null
}

/** 单回合结构化输出:3 个选项 + 状态变化(轻量引擎按白名单合并) */
export interface TurnStructured {
  options: string[]
  state_delta: {
    location?: string
    time?: string
    /** 身体状况描述(绝对覆盖) */
    health?: string
    /** 心情描述(绝对覆盖) */
    mood?: string
    quests?: string[]
    flags?: Record<string, boolean | string | number>
    /** 角色名 -> 相对当前好感度的增量(-100..100 区间内) */
    relationships?: Record<string, number>
  }
  current_chapter?: string | null
}

// ---- 简单工具 ----

/** 生成 UUID(v4,无外部依赖) */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * 章节标题识别正则(整行匹配)。
 * 支持格式:
 *  - 第X章 / 第X章：标题 / 第X章 标题(X=数字或中文数字,后接 章/节/回/卷/部/集/篇)
 *  - 一. 标题 / 壹. 标题 / 1. 标题(中文数字含大写壹贰叁…,分隔符 . 、 ．)
 *  - Chapter N / 楔子 / 序章 / 序言 / 尾声 / 番外 / 后记 / 终章(可带标题)
 * 误判防护(正文短行常见格式):
 *  - 整行上限 30 字符(章节标题一般很短;“第二节课完,程涛…”这类长句不判)
 *  - 数字点标题:点后不得紧跟数字/ASCII 字母(“59.2”“1. MLA:…”不判),行尾不得以句号/叹问号结尾(“1. 每个人带…交换。”正文列表不判)
 */
const NUMERAL_CLASS = '0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾'
export const CHAPTER_REGEX = new RegExp(
  `^\\s{0,12}(?=.{0,30}$)(?:第\\s*[${NUMERAL_CLASS}]+\\s*[章节回卷部集篇]\\s*[：:\\s]?[^\\n]*`
  + `|[${NUMERAL_CLASS}]{1,3}\\s*[.、．]\\s*(?![\\dA-Za-z])\\S[^\\n。！？!?]*`
  + `|[Cc]hapter\\s+\\d+[^\\n]*`
  + `|(?:楔子|序章|序言|引言|尾声|番外|后记|终章)\\s*[：:\\s]?[^\\n]*)$`,
  'm'
)

/** 前言头部行识别:书名行(带书名号) */
function isBookTitleLine(line: string): boolean {
  return /^《[^》]+》(?:《[^》]+》)?$/.test(line.trim())
}

/** 常见"无作者"占位写法(佚名/无名/匿名等):视为未识别 */
export function isAnonymousAuthor(name: string): boolean {
  return /^(佚名|无名|无名氏|匿名|未知|不详|无)$/.test(name.trim())
}

/**
 * 前言头部行识别:作者行(「作者:xxx」「【作者】xxx」「xxx 著」及「《书名》xxx 著」等),
 * 命中返回作者名,非作者行返回 null。纯文本确定性解析,供切分剥离与作者识别共用。
 */
export function parseAuthorName(line: string): string | null {
  const t = line.trim()
  if (!t) return null
  const labeled = /^作者\s*[:：]\s*(.+)$/.exec(t) ?? /^[【\[]\s*作者\s*[】\]]\s*[:：]?\s*(.+)$/.exec(t)
  if (labeled) {
    const name = (labeled[1] ?? '').replace(/[。;；,，]$/, '').trim()
    return isAnonymousAuthor(name) ? null : (name || null)
  }
  const signed = /^(?:《[^》]+》)?[（(]?[\u4e00-\u9fa5A-Za-z0-9·]{1,20}[）)]?\s*(?:著|編|编|译|譯)\s*$/.exec(t)
  if (signed) {
    const name = signed[0]
      .replace(/^《[^》]+》/, '')
      .replace(/[（(]|[）)]|\s*(?:著|編|编|译|譯)\s*$/g, '')
      .trim()
    return isAnonymousAuthor(name) ? null : (name || null)
  }
  return null
}

function isAuthorLine(line: string): boolean {
  return parseAuthorName(line) !== null
}

/**
 * 前言只算作者行之后到第一章之前的内容:把开头连续的书名行/作者行从首段剥离,
 * 剥离后若首段为空则不产生"前言"段(第一章成为开篇)。
 */
function stripFrontHeader(content: string): string {
  const lines = content.split('\n')
  const first = (lines[0] ?? '').trim()
  const second = (lines[1] ?? '').trim()
  let i = 0
  if (isBookTitleLine(first) || (first.length > 0 && first.length <= 30 && lines.length > 1 && isAuthorLine(second))) {
    i++
  }
  if (i < lines.length && isAuthorLine((lines[i] ?? '').trim())) i++
  while (i < lines.length && !(lines[i] ?? '').trim()) i++
  return lines.slice(i).join('\n').trim()
}

/**
 * 书名页/前言原文片段(到第一个章节标题为止,上限 maxChars):
 * 供作者识别等场景使用;章节切分流程仍会通过 stripFrontHeader 把其中的书名/作者行剥除。
 */
export function extractFrontMatter(raw: string, maxChars = 3000): string {
  const lines = raw.split(/\r?\n/)
  const head: string[] = []
  let len = 0
  for (const line of lines) {
    if (CHAPTER_REGEX.test(line)) break
    head.push(line)
    len += line.length + 1
    if (len >= maxChars) break
  }
  return head.join('\n').trim()
}

/** 从书名页/前言原文中确定性识别作者(扫描前 20 行;识别不到返回 null) */
export function detectAuthorFromFrontMatter(text: string): string | null {
  if (!text) return null
  for (const line of text.split(/\r?\n/).slice(0, 20)) {
    const name = parseAuthorName(line)
    if (name) return name
  }
  return null
}

/**
 * 把整本小说文本按章节切分。
 * 输出数组,第一个元素可能是书名/简介等前置内容(index=0,阅读页显示为"前言")。
 * 无章节标题时退化为单段(整文一个 chapter)。
 */
export function segmentChapters(raw: string): ChapterSegment[] {
  const lines = raw.split(/\r?\n/)
  const segments: ChapterSegment[] = []
  let currentTitle = ''
  let buffer: string[] = []

  const flush = () => {
    let content = buffer.join('\n').trim()
    if (content) {
      // 首段无标题时为前言段:剥离开头书名行/作者行
      if (segments.length === 0 && !currentTitle) {
        content = stripFrontHeader(content)
      }
      if (content) {
        segments.push({ title: currentTitle || '', content })
      }
    }
    buffer = []
  }

  for (const line of lines) {
    if (CHAPTER_REGEX.test(line)) {
      flush()
      currentTitle = line.trim()
    } else {
      buffer.push(line)
    }
  }
  flush()
  return segments
}

/** 编码检测辅助(UTF-8 vs GBK/GB18030) */
export function detectEncoding(bytes: Uint8Array): 'utf-8' | 'gbk' | 'gb18030' {
  // 有 UTF-8 BOM 直接判定
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8'
  }
  // 尝试严格 UTF-8 解码,失败则为 GB 系
  try {
    // TextDecoder fatal 模式下,非法 UTF-8 会抛错
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    // 有 GB18030 的四个字节扩展则判 gb18030,否则 gbk
    return 'gb18030'
  }
}
