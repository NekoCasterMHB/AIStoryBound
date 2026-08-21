// shared/novel.ts
// AI StoryBound 共享类型与工具(不依赖运行时,前后端/服务端均可引用)

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

/** 章节实体(D1 novel_chapters 行) */
export interface ChapterRow {
  id: string
  novel_id: string | null
  idx: number
  title: string | null
  content: string
  char_count: number
}

/** 解析任务实体(D1 jobs 行) */
export interface JobRow {
  id: string
  type: string
  payload: string
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number
  error: string | null
  result: string | null
  created_at: string
  updated_at: string | null
}

/** 章节切分结果 */
export interface ChapterSegment {
  title: string
  content: string
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

/** LLM 用量统计 */
export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/**
 * 上传→生成 阶段的 SSE 事件(POST /api/novels 的响应体,text/event-stream)。
 * - progress / token: 生成期间实时推送
 * - world + done: 成功收尾(done 携带真实 usage)
 * - error: 失败
 */
export type UploadSseEvent =
  | { type: 'progress', stage: string, progress: number }
  | { type: 'token', tokens: number, chars: number, elapsedMs: number, speed: number }
  | { type: 'world', world: WorldOverlay }
  | {
      type: 'done'
      id: string
      title: string
      encoding: string
      status: string
      chapter_count: number
      usage?: TokenUsage
      elapsedMs: number
    }
  | { type: 'error', message: string }

// ---- 游戏(MVP-1:会话/消息/选项/存档) ----

/** 游戏模式 */
export type GameMode = 'canonical'

/** 游戏状态(规划 §10/§33:地点/时间/HP/金钱/关系/任务/Flag;内部状态不进回复文本) */
export interface GameState {
  location?: string
  time?: string
  hp?: number
  money?: number
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

/** 存档(D1 saves 行) */
export interface SaveRow {
  id: string
  game_id: string | null
  name: string | null
  snapshot: string | null
  created_at: string
}

/** 存档快照(存于 saves.snapshot JSON,读档时整体恢复) */
export interface SaveSnapshot {
  state: GameState
  current_chapter: string | null
  summary: string | null
  messages: { id: string, idx: number, role: string, speaker: string | null, content: string }[]
}

/** 单回合结构化输出:3 个选项 + 状态变化(轻量引擎按白名单合并) */
export interface TurnStructured {
  options: string[]
  state_delta: {
    location?: string
    time?: string
    /** 相对当前值的增量(可为负) */
    hp?: number
    /** 相对当前值的增量(可为负) */
    money?: number
    quests?: string[]
    flags?: Record<string, boolean | string | number>
    /** 角色名 -> 相对当前好感度的增量(-100..100 区间内) */
    relationships?: Record<string, number>
  }
  current_chapter?: string | null
}

/** 回合接口 SSE 事件(POST /api/games/[id]/turn) */
export type TurnSseEvent =
  | { type: 'progress', stage: string, progress: number }
  | { type: 'token', tokens: number, chars: number, elapsedMs: number, speed: number }
  | { type: 'delta', text: string }
  | { type: 'options', list: { idx: number, text: string }[], state: GameState, current_chapter: string | null }
  | { type: 'usage', promptTokens?: number, completionTokens?: number, totalTokens?: number }
  | { type: 'done' }
  | { type: 'error', message: string }

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

/** 章节标题识别正则(第X章 / Chapter X / 卷) */
const CHAPTER_REGEX = /^\s{0,12}(?:第{0,1}\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷部集]|[Cc]hapter\s+\d+|楔子|序章|序言|尾声|番外|后记)\s*[：:\s].*$/m

/**
 * 把整本小说文本按章节切分。
 * 输出数组,第一个元素可能是书名/简介等前置内容(index=0)。
 * 无章节标题时退化为单段(整文一个 chapter)。
 */
export function segmentChapters(raw: string): ChapterSegment[] {
  const lines = raw.split(/\r?\n/)
  const segments: ChapterSegment[] = []
  let currentTitle = ''
  let buffer: string[] = []

  const flush = () => {
    const content = buffer.join('\n').trim()
    if (content) {
      segments.push({ title: currentTitle || '', content })
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
