// app/utils/chapters.ts
// 浏览器端章节切分(预览阅读页用)。与服务端 shared/novel.ts 的 segmentChapters 保持同一条正则,
// 不直接从 shared 值导入:app → 项目根的相对值导入会被 vite SSR 构建外部化,Nitro 二次打包无法解析。
import type { ChapterSegment, PresetNovelRow } from '#shared/novel'
import { getCachedPreset, saveCachedPreset } from './presetStore'

/** 与 shared/novel.ts CHAPTER_REGEX 一致(改动时两处同步) */
const NUMERAL_CLASS = '0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾'
const CHAPTER_REGEX = new RegExp(
  `^\\s{0,12}(?=.{0,30}$)(?:第\\s*[${NUMERAL_CLASS}]+\\s*[章节回卷部集篇]\\s*[：:\\s]?[^\\n]*`
  + `|[${NUMERAL_CLASS}]{1,3}\\s*[.、．]\\s*(?![\\dA-Za-z])\\S[^\\n。！？!?]*`
  + `|[Cc]hapter\\s+\\d+[^\\n]*`
  + `|(?:楔子|序章|序言|引言|尾声|番外|后记|终章)\\s*[：:\\s]?[^\\n]*)$`,
  'm'
)

/** 与 shared/novel.ts 一致:前言头部行识别(书名行带书名号) */
function isBookTitleLine(line: string): boolean {
  return /^《[^》]+》(?:《[^》]+》)?$/.test(line.trim())
}

/** 与 shared/novel.ts 一致:前言头部行识别(作者行「作者:xxx」「xxx 著/编/译」等) */
function isAuthorLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/^作者\s*[:：]\s*\S/.test(t)) return true
  if (/^[【[]\s*作者\s*[】\]]/.test(t)) return true
  return /^[（(]?[\u4e00-\u9fa5A-Za-z0-9·]{1,20}[）)]?\s*(?:著|編|编|译|譯)\s*$/.test(t)
}

/** 与 shared/novel.ts 一致:前言只算作者行之后的内容,剥离开头书名行/作者行 */
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

/** 按章节标题切分整本文本(与 shared/novel.segmentChapters 行为一致) */
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

export interface LoadedPresetChapters {
  chapters: ChapterSegment[]
  title: string
}

/**
 * 加载预置小说全文并切章:IndexedDB 缓存优先(可离线),未命中则经 /api/presets/[id]/download
 * 下载整份 TXT 后切章并回写缓存。标题取缓存的 meta / 服务端元数据,兜底用 id。
 */
export async function loadPresetChapters(id: string): Promise<LoadedPresetChapters> {
  const cached = await getCachedPreset(id).catch(() => null)
  if (cached) {
    const chapters = segmentChapters(cached.text)
    if (chapters.length > 0) return { chapters, title: cached.meta.title || id }
  }

  // 元数据(标题等)先走一次轻量接口,失败不阻塞正文下载
  let meta: PresetNovelRow | null = null
  try {
    meta = await $fetch<PresetNovelRow>(`/api/presets/${id}`)
  } catch {
    // 元数据拿不到时用 id 兜底
  }

  const res = await fetch(`/api/presets/${id}/download`)
  if (!res.ok) throw new Error(`下载失败 (${res.status})`)
  const text = await res.text()
  const chapters = segmentChapters(text.replace(/^\uFEFF/, ''))
  if (chapters.length === 0) throw new Error('文本解析失败(无可读章节)')

  // 写入 IndexedDB 持久化(失败不阻塞阅读)
  void saveCachedPreset(
    meta ?? { id, title: id, author: null, genre: null, description: null, cover_emoji: null },
    text
  ).catch((e) => { console.error('[preset cache] save failed:', e) })

  return { chapters, title: meta?.title || id }
}
