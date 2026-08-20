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
