// app/utils/extractCache.ts
// 断点续跑:extract(分块提取)阶段每个单元的结果缓存到 IndexedDB。
// 生成中断/失败后,同一本书再次生成时只重跑失败/缺失的单元,已完成单元直接复用(0 token)。
// key = 章节内容摘要 + 切分参数 + 模式:正文或参数任一变化即换新 key,旧缓存自然失效。
import { db, STORE_EXTRACT_CACHE } from './localDb'
import type { ChapterExtraction, ChapterSegment } from '#shared/novel'
import { EXTRACT_SCHEMA_VERSION } from '#shared/world-build'

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

/** 按章增量哈希:避免整本 JSON.stringify 卡主线程(45×5 万字会让提取停在 15%、进行中 0)。
 *  crypto.subtle 在非安全上下文(http 非 localhost)不可用,回退 FNV-1a;缓存 key 只需一致性,不要求密码学强度。 */
async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-1', bytes)
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 并发上限:上千章的书也不让主线程被一串 await 拖住 */
const HASH_CONCURRENCY = 8

/** 计算缓存 key:章节正文哈希 + 切分参数 + 模式(任一变化不复用) */
export async function extractCacheKey(
  title: string,
  chapters: ChapterSegment[],
  opts: { eco: boolean, unitMaxChars: number, unitOverlapChars: number }
): Promise<string> {
  const enc = new TextEncoder()
  const parts: string[] = [
    `v${EXTRACT_SCHEMA_VERSION}`,
    title,
    `eco:${opts.eco ? 1 : 0}`,
    `max:${opts.unitMaxChars}`,
    `overlap:${opts.unitOverlapChars}`,
    `n:${chapters.length}`
  ]
  const hashes = new Array(chapters.length)
  let next = 0
  const workers = Array.from({ length: Math.min(HASH_CONCURRENCY, Math.max(1, chapters.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= chapters.length) return
      hashes[i] = await sha1Hex(enc.encode(chapters[i]!.content))
    }
  })
  await Promise.all(workers)
  for (let i = 0; i < chapters.length; i++) {
    parts.push(chapters[i]!.title ?? '')
    parts.push(hashes[i])
  }
  return sha1Hex(enc.encode(parts.join('\n')))
}

/** 带超时的表操作:缓存只是优化,任何卡顿都不能拖住生成主流程 */
async function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), 2000))
  ])
}

/** 读取该书提取缓存(无/环境不支持时返回 null) */
export async function loadExtractCache(key: string): Promise<ExtractCacheEntry | null> {
  if (typeof indexedDB === 'undefined') return null
  return withTimeout(db.table(STORE_EXTRACT_CACHE).get(key) as Promise<ExtractCacheEntry | undefined>, undefined)
    .then(v => v ?? null)
}

/** 清空全部提取缓存(生成完成/取消/重新上传时调用,防止多次生成后缓存无限累加占满 IndexedDB)。
 *  带 2 秒超时:缓存只是优化,绝不能拖住上传/生成主流程。 */
export async function clearExtractCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await withTimeout(db.table(STORE_EXTRACT_CACHE).clear(), undefined)
}

/** 增量写入单个成功单元(中断也保留已完成的;写失败忽略,缓存只是优化;单事务 get→put 原子化) */
export async function saveExtractUnit(
  key: string,
  index: number,
  extraction: ChapterExtraction,
  meta: { title: string, eco: boolean }
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await withTimeout(db.transaction('rw', db.table(STORE_EXTRACT_CACHE), async () => {
    const table = db.table(STORE_EXTRACT_CACHE)
    const entry = (await table.get(key)) ?? {
      key, title: meta.title, eco: meta.eco, done: {} as Record<number, ChapterExtraction>, updatedAt: Date.now(), complete: false
    }
    entry.done[index] = extraction
    entry.updatedAt = Date.now()
    await table.put(entry)
  }), undefined)
}

/** 全部单元成功后标记 complete(下次全量复用;单事务读改写原子化) */
export async function markExtractComplete(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await withTimeout(db.transaction('rw', db.table(STORE_EXTRACT_CACHE), async () => {
    const table = db.table(STORE_EXTRACT_CACHE)
    const entry = await table.get(key)
    if (!entry) return
    entry.complete = true
    entry.updatedAt = Date.now()
    await table.put(entry)
  }), undefined)
}
