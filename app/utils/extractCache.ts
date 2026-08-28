// app/utils/extractCache.ts
// 断点续跑:extract(分块提取)阶段每个单元的结果缓存到 IndexedDB。
// 生成中断/失败后,同一本书再次生成时只重跑失败/缺失的单元,已完成单元直接复用(0 token)。
// key = 章节内容摘要 + 切分参数 + 模式:正文或参数任一变化即换新 key,旧缓存自然失效。
import { db } from './localDb'
import type { ChapterExtraction, ChapterSegment } from '#shared/novel'

/** 存储名与 localDb.ts 的 STORE_EXTRACT_CACHE 一致(Nuxt auto-import 下避免重复导出,此处不导出) */
const STORE = 'extract-cache'

export interface ExtractCacheEntry {
  key: string
  title: string
  eco: boolean
  /** 单元 index -> 成功提取结果(仅成功单元入库,失败不写) */
  done: Record<number, ChapterExtraction>
  updatedAt: number
  /** 全部单元成功时才为 true;中断/失败保留 false(下次续跑) */
  complete: boolean
}

async function cacheDb() {
  const d = await db()
  if (!d) return null
  return d
}

/** 计算缓存 key:chapters 全文摘要 + 切分参数 + 模式(任一变化不复用) */
export async function extractCacheKey(
  title: string,
  chapters: ChapterSegment[],
  opts: { eco: boolean, unitMaxChars: number, unitOverlapChars: number }
): Promise<string> {
  const data = JSON.stringify({ title, chapters, eco: opts.eco, max: opts.unitMaxChars, overlap: opts.unitOverlapChars })
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 读取该书提取缓存(无/环境不支持时返回 null) */
export async function loadExtractCache(key: string): Promise<ExtractCacheEntry | null> {
  if (typeof indexedDB === 'undefined') return null
  const d = await cacheDb()
  if (!d) return null
  return (await d.get(STORE, key)) ?? null
}

/** 增量写入单个成功单元(中断也保留已完成的;写失败忽略,缓存只是优化) */
export async function saveExtractUnit(
  key: string,
  index: number,
  extraction: ChapterExtraction,
  meta: { title: string, eco: boolean }
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await cacheDb()
  if (!d) return
  const tx = d.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const entry = (await store.get(key)) ?? {
    key, title: meta.title, eco: meta.eco, done: {} as Record<number, ChapterExtraction>, updatedAt: Date.now(), complete: false
  }
  entry.done[index] = extraction
  entry.updatedAt = Date.now()
  await store.put(entry)
}

/** 全部单元成功后标记 complete(下次全量复用) */
export async function markExtractComplete(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await cacheDb()
  if (!d) return
  const entry = await d.get(STORE, key)
  if (!entry) return
  entry.complete = true
  entry.updatedAt = Date.now()
  await d.put(STORE, entry)
}
