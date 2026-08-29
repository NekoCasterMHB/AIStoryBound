// app/utils/readingStore.ts
// 沉浸式阅读进度的 IndexedDB 持久化(reading store,key = `${src}:${id}`)。
// 遵循本地优先模式:SSR 守卫 + 写入前 JSON 序列化(剥离 Vue reactive 代理)。
import { db } from './localDb'
import type { ReadingProgress } from '#shared/novel'

const STORE_READING = 'reading'

/** 读取某本书的阅读进度;未命中返回 null */
export async function getReadingProgress(key: string): Promise<ReadingProgress | null> {
  if (typeof indexedDB === 'undefined') return null
  return (await db.table(STORE_READING).get(key)) ?? null
}

/** 写入阅读进度(失败不抛,阅读不因存储异常中断) */
export async function saveReadingProgress(p: ReadingProgress): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await db.table(STORE_READING).put(JSON.parse(JSON.stringify(p)))
  } catch (e) {
    console.error('[reading] save failed:', e)
  }
}

/** 列出全部阅读进度(书架展示用),按更新时间倒序 */
export async function listReadingProgress(): Promise<ReadingProgress[]> {
  if (typeof indexedDB === 'undefined') return []
  const all = (await db.table(STORE_READING).toArray()) as ReadingProgress[]
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 删除某本书的阅读进度(如作品被删除时清理) */
export async function deleteReadingProgress(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_READING).delete(key)
}
