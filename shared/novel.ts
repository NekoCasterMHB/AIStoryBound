// shared/novel.ts
// AI Word2World 共享类型与工具(不依赖运行时,前后端/服务端均可引用)
import { detectNovelEncoding } from './novel-encoding'
import type { NovelEncoding } from './novel-encoding'

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
  /** 是否已有预生成世界(列表接口附加;用户可直接 0 token 进入,未预生成回退自定义生成) */
  hasWorld?: boolean
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
/** 成人性爱向人物属性(虚构角色设定;每项均可空) */
export interface SexAttrs {
  /** 偏好体位 */
  positions?: string | null
  /** 床笫习惯/癖好 */
  habits?: string | null
  /** 语言挑逗风格(床上说话方式) */
  tease?: string | null
  /** 性能力/技巧 */
  skill?: string | null
  /** 性器官大小形状 */
  member?: string | null
  /** 持久能力 */
  stamina?: string | null
  /** 身材曲线 */
  figure?: string | null
  /** 手指粗细 */
  fingers?: string | null
  /** 是否戴套:true=戴,false=不戴,null=未知 */
  condom?: boolean | null
}

/** SexAttrs 中文本字段的键(condom 为布尔三态,单独处理) */
export const SEX_TEXT_KEYS = ['positions', 'habits', 'tease', 'skill', 'member', 'stamina', 'figure', 'fingers'] as const
export type SexTextField = (typeof SEX_TEXT_KEYS)[number]

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
  /** 性欲强度,0-100 整数(静态特质:数值越小越性冷淡、欲望波动越小越难挑起;数值越大欲望越强;影响 AI 演绎的互动分寸) */
  desire?: number | null
  /** 成人题材玩法喜好(theme=玩法,view=喜好态度,role=承受/施予/双方,detail=具体表现与敏感度) */
  kinks?: { theme: string, view: string | null, role: string | null, detail: string | null }[]
  /** 成人性爱向属性(体位/语言挑逗/尺寸/持久等,影响叙事细节演绎) */
  sex?: SexAttrs
  /** 阶段变体:按细纲段与基础卡的差异(生成流水线从原著提取;游玩时按当前段叠加,stage 为 0-based 段下标)。
   *  字段名保留 chapterVariants 旧名是为兼容 IndexedDB 旧数据,语义已从"章节"改为"段" */
  chapterVariants?: CharacterChapterVariant[]
}

/** 角色在某阶段(细纲段/提取单元)与基础卡(或上一段快照)的差异;patch 只记录变化的字段 */
export interface CharacterChapterVariant {
  /** 0-based 阶段段号(对应 storyline 细纲段下标,与提取单元一一对应) */
  stage: number
  /** @deprecated 旧章节下标(仅旧存档数据存在;读取时以 stage 优先,缺失时兜底) */
  chapter?: number
  /** 段标签(展示用,如「第3段」;旧数据为章节标题) */
  title?: string | null
  /** 本段处境/状态一句话(身份转变、受伤、被囚、身亡等) */
  status?: string | null
  /** 与基础卡(或上一段快照)的差异:仅记录该段发生变化的字段 */
  patch: Partial<Omit<CharacterCard, 'name' | 'role' | 'chapterVariants'>>
}

/** 角色运行时动态状态(随互动演进;LLM 每回合回报,白名单合并) */
export interface CharacterDynamicState {
  /** 当前处境/状态一句话 */
  status?: string | null
  /** 当前位置 */
  location?: string | null
  /** 当前情绪 */
  mood?: string | null
  /** 生死 */
  dead?: boolean | null
  /** 其余人物卡字段补丁(全字段可变;字符串/数组整体替换) */
  patch?: Partial<Omit<CharacterCard, 'name' | 'role' | 'chapterVariants'>>
  /** 变化履历(代码按每回合 delta 生成摘要;章节时间线展示用) */
  log?: { idx: number, text: string }[]
}

/** 性欲强度 0-100 的五档位(展示与提示词共用;区间 0-19 / 20-39 / 40-59 / 60-79 / 80-100) */
export const DESIRE_TIERS: { max: number, label: string, desc: string }[] = [
  { max: 19, label: '懵懂无知', desc: '对情感与欲望缺乏认知,单纯青涩' },
  { max: 39, label: '腼腆娇羞', desc: '开始意识到暧昧,容易害羞、躲闪' },
  { max: 59, label: '情动意乱', desc: '情感和欲望逐渐萌发,开始主动产生期待' },
  { max: 79, label: '欲念难抑', desc: '欲望明显增强,理智与克制逐渐减弱' },
  { max: 100, label: '兽欲大发', desc: '欲望彻底压过理性,进入强烈失控状态' }
]

/** 数值 → 档位名;缺失/越界返回 null */
export function desireTierName(v: number | null | undefined): string | null {
  if (v == null) return null
  const tier = DESIRE_TIERS.find(t => v <= t.max)
  return tier?.label ?? null
}

/** 全书玩法聚合(成书写入 overlay;本地聚合也可直接产出) */
export interface KinkProfileEntry {
  theme: string
  count: number
  /** 该玩法最常见态度:喜欢/厌恶/接受/无感 */
  dominantView: string | null
}

/** 尺度档位(成书/本地聚合写入 overlay.heat) */
export type HeatLevel = '淡' | '中' | '烈'

/** 世界观速览(规划 §5),整体存于 novels.world_state */
export interface WorldOverlay {
  title?: string
  genre?: string
  summary?: string
  characters?: CharacterCard[]
  /** 子类型 + 玩法 + 关系原型,8~12 个短标签 */
  tags?: string[]
  /** 全书主性向:男女/女女/男男/混合/不明 */
  orientation?: string
  /** 舞台 + 体系一句话 */
  setting?: string
  /** 整体尺度 */
  heat?: HeatLevel
  /** 内容警告(与 LocalWork.warnings 生成告警区分) */
  contentWarnings?: string[]
  /** 关系/剧情原型 */
  tropes?: string[]
  /** 全书玩法 Top N */
  kinkProfile?: KinkProfileEntry[]
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
  /** 该角色在本提取单元的处境/状态一句话(身份转变、受伤、被囚、身亡等;章节变体素材) */
  status?: string | null
  /** 性欲强度,0-100 整数(提取时按原文行为推断) */
  desire?: number | null
  /** 成人题材玩法喜好(theme=玩法,view=喜欢/厌恶/接受,role=承受/施予/双方;按原文行为与对话推断) */
  kinks?: { theme: string, view?: string | null, role?: string | null, quote?: string | null }[]
  /** 成人性爱向属性(按原文行为与对话推断,可部分填写) */
  sex?: SexAttrs
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

/** 单提取单元的情节纪要(按字数切段,不依赖章节标题) */
export interface PlotBeat {
  /** 本段发生了什么(80-150 字,按时间顺序) */
  summary: string
  /** 出场人名 */
  cast?: string[]
  /** 主要地点 */
  place?: string | null
  /** 本段相对上一段的推进/转折 */
  turn?: string | null
  /** 段末未完成的悬念 */
  hook?: string | null
}

/** 合并后的故事线一拍(按提取单元顺序,失败单元跳过不编造) */
export interface StoryBeat {
  /** 0-based 段序(对应提取单元下标) */
  index: number
  /** 本段在全书中的起始字符偏移 */
  startChar: number
  /** 展示标签(沿用提取单元 label,仅展示) */
  label: string
  summary: string
  cast: string[]
  place?: string | null
  turn?: string | null
  hook?: string | null
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
  /** 本段情节纪要(按字数切段;失败/旧缓存可缺) */
  plot_beat?: PlotBeat | null
}

/** 合并后的实体(Merge 阶段产物,sources 携带全文溯源) */
export interface MergedCharacter extends ExtractedCharacter {
  sources: EntitySource[]
  mentionCount: number
  /** 章节变体(传入 chapters 合并时生成;成卡阶段挂到卡上) */
  chapterVariants?: CharacterChapterVariant[]
  /** 身份在各章节的全部不同表述(可并存,如 留学生/作家;成书 AI 据此合并出完整人设) */
  identityVariants?: string[]
  /** 外貌在各章节的全部不同表述(不同侧面/阶段描述) */
  appearanceVariants?: string[]
  /** 背景在各章节的全部不同表述(同一件事的不同说法或不同侧面) */
  backgroundVariants?: string[]
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
  overlay?: WorldOverlay
  /** 按字数切段合并的完整故事线(与 overlay 并列,避免人物卡保存踩到大数组) */
  storyline?: StoryBeat[]
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
  /** 剧情当前推进到的细纲段下标(0-based;由收尾器按回回报,用于阶段变体与回注;旧存档无此字段) */
  currentBeat?: number | null
  summary?: { idx: number, text: string } | null
  /** 云端同步进度:上次成功同步的最后一条消息 idx(-1=从未同步;回滚后失效,下次同步自动转全量重建) */
  lastSyncedIdx?: number
  /** 开局设定(仅对首回合生效;旧存档无此字段=原有自由开场) */
  opening?: {
    /** ai=AI 生成开场供选择 beat=按细纲段开始 custom=玩家输入背景故事 */
    mode: 'ai' | 'beat' | 'custom'
    /** mode=beat:细纲段在 storyline 中的下标(0-based) */
    beatIndex?: number
    /** mode=beat:细纲段标题,如「第3段」 */
    beatTitle?: string
    /** mode=beat:细纲段情节摘要 */
    beatSummary?: string
    /** mode=beat:该段起始章节正文(供开场演绎,约 2500 字窗口) */
    beatText?: string
    /** mode=beat:前一段情节(背景;非首段时注入) */
    prevBeat?: { title?: string, text: string }
    /** mode=beat:后一段情节(走向;非末段时注入) */
    nextBeat?: { title?: string, text: string }
    /** mode=ai:玩家选定的开场设定;mode=custom:玩家输入的背景故事 */
    scene?: string
    /** 是否已按起始情节初始化过性欲值(避免回滚开局后重复调用) */
    desiresSeeded?: boolean
  }
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
  /** 角色名 -> 性欲值(0-100,动态状态:随心情/情景/挑逗变化,戳中嗜好大幅加速,低强度角色波动小、高值后上涨加速) */
  desires?: Record<string, number>
  /** 角色名 -> 运行时动态状态(处境/位置/情绪/生死及人物卡字段补丁;随互动演进) */
  characterStates?: Record<string, CharacterDynamicState>
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
    /** 角色名 -> 性欲值增量(0-100 区间内);可附触发玩法名与场景,引擎按人物卡嗜好放大 */
    desires?: Record<string, number | { delta: number, kink?: string, scene?: 'reward' | 'punish' }>
    /** 角色名 -> 动态状态变化(status/location/mood/dead + 任意人物卡字段补丁;无变化的角色省略) */
    character_states?: Record<string, CharacterDynamicState>
  }
  /** 剧情当前推进到的细纲段序号(1-based,每回合报告;仍在同段保持同值;不确定可省略) */
  current_beat?: number | null
  /** 整局剧情摘要(覆盖式更新:基于旧摘要+近期剧情压缩,保留关键关系/伏笔/进展) */
  summary?: string
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
  const labeled = /^作者\s*[:：]\s*(.+)$/.exec(t) ?? /^[【[]\s*作者\s*[】\]]\s*[:：]?\s*(.+)$/.exec(t)
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

/** 编码检测辅助:按乱码特征评分择优(UTF-8/UTF-16/GB18030/GBK/Big5/二重乱码修复),详见 novel-encoding.ts */
export function detectEncoding(bytes: Uint8Array): NovelEncoding {
  return detectNovelEncoding(bytes).encoding
}
