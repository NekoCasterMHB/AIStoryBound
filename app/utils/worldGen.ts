// app/utils/worldGen.ts
// 本地作品库(IndexedDB works)与小说文本解析工具。
// 世界生成统一走云端任务(见 worldGenCloud.ts / server Workflows),浏览器端不再编排生成管线。
import { extractFrontMatter } from '#shared/novel'
import { detectNovelEncoding } from '#shared/novel-encoding'
import type { ChapterSegment, LocalWork } from '#shared/novel'
import { db } from './localDb'

export interface GenerateProgress {
  stage: 'parse' | 'author' | 'extract' | 'merge' | 'check' | 'synthesize' | 'arcs' | 'done'
  /** extract 阶段:已完成单元数 */
  doneUnits: number
  totalUnits: number
  /** 累计消耗 token(已完成调用的真实 usage) */
  tokensUsed: number
  /** 实时估算:已完成真实用量 + 流式进行中调用的估算合计(单调不减) */
  liveTokens: number
  warnings: string[]
  /** 调试:当前在跑的提取单元标签 */
  debugHint?: string
  /** 调试:进行中的并发调用数 */
  inflight?: number
  /** 调试:单次提取输入上限(字符) */
  unitMaxChars?: number
}

/** 本地解析 TXT 文件:编码检测 + 清洗 + 单段全文(不再按章节切分) */
export async function parseLocalNovel(file: File): Promise<{ title: string, encoding: string, chapters: ChapterSegment[], frontMatter: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // 检测编码并直接取解码结果(返回值可能来自二重乱码修复通道,不是合法的 TextDecoder 标签)
  const detected = detectNovelEncoding(bytes)
  return {
    title: file.name.replace(/\.(txt|text)$/i, '') || '未命名小说',
    encoding: detected.encoding,
    // 书名页/前言原文(作者识别用)
    frontMatter: extractFrontMatter(detected.text),
    chapters: toContentSegments(detected.text)
  }
}

/** 整本文本规范化为单个正文段(本地作品/预置书统一存单段全文,提取按字数分块,不依赖章节结构) */
export function toContentSegments(text: string): ChapterSegment[] {
  const cleaned = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!cleaned) {
    throw new Error('文本为空或无法解析')
  }
  return [{ title: '', content: cleaned }]
}

/** 是否旧版分章格式作品:新版(worldFormat=2)恒为 false;旧数据缺省按章节数判定(多段=旧版) */
export function isLegacyChapteredWork(w: { chapters: ChapterSegment[], worldFormat?: 2 }): boolean {
  if (w.worldFormat === 2) return false
  return w.chapters.length > 1
}

// ---- 本地作品库(IndexedDB works) ----

const STORE_WORKS = 'works'

export async function listWorks(): Promise<LocalWork[]> {
  if (typeof indexedDB === 'undefined') return []
  // 按最后操作时间倒序(无 updatedAt 的旧数据回退创建时间)
  return (await db.table(STORE_WORKS).toArray()).sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
  )
}

export async function getWork(id: string): Promise<LocalWork | null> {
  if (typeof indexedDB === 'undefined') return null
  return (await db.table(STORE_WORKS).get(id)) ?? null
}

/** 按来源云端任务 id 查已安装作品(手动下载时判定"该任务是否已装过",防同一任务重复落库) */
export async function getWorkBySourceTask(taskId: string): Promise<LocalWork | null> {
  if (typeof indexedDB === 'undefined' || !taskId) return null
  const all = await db.table(STORE_WORKS).toArray()
  return all.find(w => w.sourceTaskId === taskId) ?? null
}

export async function saveWork(work: LocalWork): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_WORKS).put(JSON.parse(JSON.stringify(work)))
}

export async function deleteWork(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_WORKS).delete(id)
}

/** 记录一次浏览/操作:刷新最后操作时间(书架卡片展示用;无作品时静默) */
export async function touchWork(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const work = await getWork(id)
  if (!work) return
  work.updatedAt = new Date().toISOString()
  await saveWork(work)
}

/** 游玩消耗追加到作品累计 tokens(书架卡片展示用),同时刷新最后操作时间 */
export async function addWorkTokens(id: string, tokens: number): Promise<void> {
  if (typeof indexedDB === 'undefined' || !tokens || tokens <= 0) return
  const work = await getWork(id)
  if (!work) return
  work.tokensUsed = (work.tokensUsed ?? 0) + tokens
  work.updatedAt = new Date().toISOString()
  await saveWork(work)
}
