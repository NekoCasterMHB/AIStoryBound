// app/utils/worldGen.ts
// 本地作品库(IndexedDB works)与小说文本解析工具。
// 世界生成统一走云端任务(见 worldGenCloud.ts / server Workflows),浏览器端不再编排生成管线。
import { extractFrontMatter, normalizeCharacterCards } from '#shared/novel'
import { detectNovelEncoding } from '#shared/novel-encoding'
import type { ChapterSegment, LocalWork } from '#shared/novel'
import { db, STORE_WORKS_META } from './localDb'

export interface GenerateProgress {
  stage: 'parse' | 'author' | 'extract' | 'merge' | 'check' | 'synthesize' | 'arcs' | 'annotate' | 'done'
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

/** 读出的作品统一把 overlay.characters 归一为当前 CharacterCard 形状(兼容外部/旧版本 zip 导入的结构化外貌等),返回新对象不改库 */
function normalizeWork(w: LocalWork): LocalWork {
  const chars = w.overlay?.characters
  if (!chars || !chars.length) return w
  return { ...w, overlay: { ...w.overlay, characters: normalizeCharacterCards(chars) } }
}

export async function listWorks(): Promise<LocalWork[]> {
  if (typeof indexedDB === 'undefined') return []
  // 按最后操作时间倒序(无 updatedAt 的旧数据回退创建时间)
  return (await db.table(STORE_WORKS).toArray()).map(normalizeWork).sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
  )
}

export async function getWork(id: string): Promise<LocalWork | null> {
  if (typeof indexedDB === 'undefined') return null
  const w = (await db.table(STORE_WORKS).get(id)) ?? null
  return w ? normalizeWork(w) : null
}

/** 按来源云端任务 id 查已安装作品(手动下载时判定"该任务是否已装过",防同一任务重复落库)。
 *  v14 起走 sourceTaskId 索引(v14 前的全表扫描行为等价,索引对旧行自动缺失跳过) */
export async function getWorkBySourceTask(taskId: string): Promise<LocalWork | null> {
  if (typeof indexedDB === 'undefined' || !taskId) return null
  const found = (await db.table(STORE_WORKS).where('sourceTaskId').equals(taskId).first()) ?? null
  return found ? normalizeWork(found) : null
}

export async function saveWork(work: LocalWork): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_WORKS).put(JSON.parse(JSON.stringify(work)))
}

export async function deleteWork(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_WORKS).delete(id)
  await db.table(STORE_WORKS_META).delete(id)
}

/** 记录一次浏览/操作:刷新最后操作时间(书架卡片展示用;无作品时静默) */
export async function touchWork(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const work = await getWork(id)
  if (!work) return
  work.updatedAt = new Date().toISOString()
  await saveWork(work)
}

/** v1 作品的游玩计量旁路(works-meta 表小行):IndexedDB 无部分更新,
 *  每回合 AI 记账若整行重写 works 会搬全部章节正文(v14 books 同款拆分,works 为遗留层补一份) */
interface WorksMetaRow { id: string, tokensUsed?: number, playedAt?: string }

/** 游玩消耗追加到作品累计 tokens(书架卡片展示用):计量写旁路小行,读侧合并;不再每回合整书重写 */
export async function addWorkTokens(id: string, tokens: number): Promise<void> {
  if (typeof indexedDB === 'undefined' || !tokens || tokens <= 0) return
  await db.transaction('rw', db.table(STORE_WORKS_META), db.table(STORE_WORKS), async () => {
    const meta = (await db.table(STORE_WORKS_META).get(id)) as WorksMetaRow | undefined
    const work = (await db.table(STORE_WORKS).get(id)) as LocalWork | undefined
    if (!work) return
    // 基线同步:旁路计量与行内计量取大者(行内值来自安装/迁移时刻,旁路值随游玩累加)
    const base = Math.max(meta?.tokensUsed ?? 0, work.tokensUsed ?? 0)
    const next = base + tokens
    await db.table(STORE_WORKS_META).put({ id, tokensUsed: next, playedAt: new Date().toISOString() })
    // 行内 tokensUsed 停更(读取时合并旁路值);updatedAt 不每回合刷新,书架排序稳定
  })
}

/** 读 v1 作品的游玩消耗(行内值与旁路值取大者) */
export async function getWorkTokensUsed(id: string): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0
  const [meta, work] = await Promise.all([
    db.table(STORE_WORKS_META).get(id) as Promise<WorksMetaRow | undefined>,
    db.table(STORE_WORKS).get(id) as Promise<LocalWork | undefined>
  ])
  return Math.max(meta?.tokensUsed ?? 0, work?.tokensUsed ?? 0)
}
