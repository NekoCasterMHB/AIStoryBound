// app/utils/bookStoreV2.ts
// 作品格式 v2(aisb-book)本地存储:IndexedDB book2 store,以 zip 字节存储(方案 B,与旧 works 并存,存量不迁移)。
//  - 保存:BookDoc → zip 字节 → book2(行 id 用 uuid,与旧 works 的 id 体系一致;BookDoc 本身不带 id)
//  - 读取:book2 zip → bookZipToDoc → BookDoc;可按需转换为 LocalWork(经 v2-convert)给旧引擎/旧界面
//  - 列目录:不解析全文,仅读 id/title/段数(Book2Row 元数据)
import { db, type Book2Row } from './localDb'
import { bookDocToZip, bookZipToDoc, type BookDoc, type BookCharacter } from '#shared/novel-v2'
import { v2ToWork } from './v2-convert'
import { uuid } from '#shared/novel'
import { characterCardToBook } from '#shared/normalize-card'
import { getWork } from './worldGen'
import type { LocalWork, CharacterCard } from '#shared/novel'

/** 保存一部 v2 作品到 book2(写入 zip 字节 + 目录元数据);返回作品 id */
export async function saveBook2(doc: BookDoc, id?: string): Promise<string> {
  if (typeof indexedDB === 'undefined') return id ?? ''
  const bookId = id ?? uuid()
  const zip = bookDocToZip(doc)
  const row: Book2Row = {
    id: bookId,
    title: doc.manifest.title,
    segmentCount: Object.keys(doc.segments).length,
    charCount: Object.keys(doc.characters).length,
    updatedAt: new Date().toISOString(),
    zip
  }
  await db.table('book2').put(row)
  return bookId
}

/** 按 id 读取 v2 作品,解析为 BookDoc */
export async function loadBook2(id: string): Promise<BookDoc | null> {
  if (typeof indexedDB === 'undefined') return null
  const row = await db.table('book2').get(id)
  if (!row) return null
  try {
    return bookZipToDoc(row.zip)
  } catch {
    return null // zip 损坏:返回 null,由调用方提示重新导入
  }
}

/** 读取 v2 作品并转换为 LocalWork(供旧引擎/旧界面使用;返回值带 book2SourceId 标记真源) */
export async function loadBook2AsWork(id: string): Promise<LocalWork | null> {
  const doc = await loadBook2(id)
  if (!doc) return null
  const row = await db.table('book2').get(id)
  const w = v2ToWork(doc, { id, createdAt: row?.updatedAt, updatedAt: row?.updatedAt })
  w.book2SourceId = id
  return w
}

/** 按 id 读取作品视图:优先 book2(v2 真源),缺则 works(v1)。返回 LocalWork 带 book2SourceId 表示来源。 */
export async function loadWorkSmart(id: string): Promise<LocalWork | null> {
  const b2 = await loadBook2AsWork(id)
  if (b2) return b2
  return getWork(id)
}

/** 把编辑后的人物卡写回 v2 作品(characters/ 基础卡;段角色文件与正文不受影响) */
export async function saveBook2Characters(id: string, cards: CharacterCard[]): Promise<void> {
  const doc = await loadBook2(id)
  if (!doc) throw new Error('本地未找到该 v2 作品')
  const characters: Record<string, BookCharacter> = {}
  for (const c of cards) {
    const bc = characterCardToBook(c)
    if (bc) characters[bc['姓名']] = bc
  }
  doc.characters = characters
  doc.manifest.charCount = Object.keys(characters).length
  await saveBook2(doc, id)
}

/** 列目录:返回所有 v2 作品的元数据(不解析全文) */
export async function listBook2(): Promise<Book2Row[]> {
  if (typeof indexedDB === 'undefined') return []
  return (await db.table('book2').toArray())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 删除一部 v2 作品 */
export async function deleteBook2(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table('book2').delete(id)
}
