// app/utils/bookStoreV2.ts
// 作品格式 v2(aisb-book)本地存储:IndexedDB 结构化四表(books/book-segments/book-characters/book-world)。
// 库内是结构化行;zip 只在边界序列化(导入分享包、导出/备份/分享时现打包),读写不再反复解包/重打包。
//  - 保存:BookDoc → 拆行(一个事务);行 id 用 uuid,与旧 works 的 id 体系一致(BookDoc 本身不带 id)
//  - 读取:并行查四表 → 内存拼装 BookDoc;可按需转换为 LocalWork(经 v2-convert)给旧引擎/旧界面
//  - 粒度:人物卡/元数据走单行更新,通用修改走"拼装-改-整写"(事务保证原子)
import { db, type BookMetaRow, type BookSegmentRow, type BookCharacterRow, type BookWorldRow } from './localDb'
import { bookDocToZip, bookZipToDoc, type BookDoc, type BookCharacter } from '#shared/novel-v2'
import { v2ToWork, workToV2 } from '#shared/v2-convert'
import { uuid } from '#shared/novel'
import { characterCardToBook } from '#shared/normalize-card'
import { buildBookView, type BookView } from '#shared/book-view'
import { getWork, touchWork, addWorkTokens } from './worldGen'
import type { LocalWork, CharacterCard } from '#shared/novel'

const nowIso = () => new Date().toISOString()

/** BookDoc → 四表行(拆解;一个事务内写入) */
async function saveBookDoc(id: string, doc: BookDoc): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const meta: BookMetaRow = {
    id,
    title: doc.manifest.title,
    ...(doc.manifest.author ? { author: doc.manifest.author } : {}),
    updatedAt: nowIso(),
    manifest: doc.manifest,
    fulltext: doc.fulltext,
    ...(doc.games && Object.keys(doc.games).length > 0 ? { games: doc.games } : {})
  }
  const segRows: BookSegmentRow[] = Object.entries(doc.segments).map(([key, dir]) => ({
    id,
    key,
    seq: Number.parseInt(key, 10) || 0,
    canon: dir.canon,
    characters: dir.characters
  }))
  const charRows: BookCharacterRow[] = Object.entries(doc.characters).map(([name, card]) => ({ id, name, card }))
  const worldRow: BookWorldRow = { id, ...(doc.world ? { world: doc.world } : {}) }
  await db.transaction('rw', db.books, db['book-segments'], db['book-characters'], db['book-world'], async () => {
    await Promise.all([
      db['book-segments'].where('id').equals(id).delete(),
      db['book-characters'].where('id').equals(id).delete(),
      db['book-world'].delete(id)
    ])
    await Promise.all([
      db.books.put(meta),
      db['book-segments'].bulkPut(segRows),
      db['book-characters'].bulkPut(charRows),
      ...(doc.world ? [db['book-world'].put(worldRow)] : [])
    ])
  })
}

/** 四表行 → BookDoc(拼装;纯内存,不解压) */
async function loadBookDocWithMeta(id: string): Promise<{ doc: BookDoc, meta: BookMetaRow } | null> {
  if (typeof indexedDB === 'undefined') return null
  const [meta, segRows, charRows, worldRow] = await Promise.all([
    db.books.get(id),
    db['book-segments'].where('id').equals(id).toArray(),
    db['book-characters'].where('id').equals(id).toArray(),
    db['book-world'].get(id)
  ])
  if (!meta) return null
  const segments: BookDoc['segments'] = {}
  for (const r of [...segRows].sort((a, b) => a.seq - b.seq)) {
    segments[r.key] = { canon: r.canon, characters: r.characters ?? {} }
  }
  const characters: Record<string, BookCharacter> = {}
  for (const r of charRows) characters[r.name] = r.card
  const doc: BookDoc = {
    manifest: meta.manifest,
    fulltext: meta.fulltext,
    segments,
    characters,
    ...(worldRow?.world ? { world: worldRow.world } : {}),
    ...(meta.games && Object.keys(meta.games).length > 0 ? { games: meta.games } : {})
  }
  return { doc, meta }
}

/** 保存一部 v2 作品(拆行入库);返回作品 id */
export async function saveBook2(doc: BookDoc, id?: string): Promise<string> {
  const bookId = id ?? uuid()
  await saveBookDoc(bookId, doc)
  return bookId
}

/** 按 id 读取 v2 作品,拼装为 BookDoc */
export async function loadBook2(id: string): Promise<BookDoc | null> {
  const loaded = await loadBookDocWithMeta(id)
  return loaded?.doc ?? null
}

/** 读取 v2 作品并转换为 LocalWork(供旧引擎/旧界面使用;返回值带 book2SourceId 标记真源) */
export async function loadBook2AsWork(id: string): Promise<LocalWork | null> {
  const loaded = await loadBookDocWithMeta(id)
  if (!loaded) return null
  const w = v2ToWork(loaded.doc, { id, createdAt: loaded.meta.updatedAt, updatedAt: loaded.meta.updatedAt })
  w.book2SourceId = id
  // 游玩消耗累计在 books 行级字段(不进 zip),读取视图映射到 LocalWork 供书架卡片展示
  if (loaded.meta.tokensUsed) w.tokensUsed = (w.tokensUsed ?? 0) + loaded.meta.tokensUsed
  return w
}

/** 刷新 v2 作品的最后操作时间(书架排序;单行更新) */
export async function touchBook2(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.books.update(id, { updatedAt: nowIso() })
}

/** 累加游玩消耗(books 行级字段,不触碰段/卡数据) */
export async function addBook2Tokens(id: string, tokens: number): Promise<void> {
  if (typeof indexedDB === 'undefined' || tokens <= 0) return
  const meta = await db.books.get(id)
  if (!meta) return
  await db.books.update(id, { tokensUsed: (meta.tokensUsed ?? 0) + tokens })
}

/** 智能触碰:v2 作品走 books 行,旧 v1 作品走 works 行(阅读/进游戏时刷新排序) */
export async function touchWorkSmart(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  if (await db.books.get(id)) return touchBook2(id)
  return touchWork(id)
}

/** 智能消耗累计:v2 作品走 books 行,旧 v1 作品走 works 行 */
export async function addWorkTokensSmart(id: string, tokens: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  if (await db.books.get(id)) return addBook2Tokens(id, tokens)
  return addWorkTokens(id, tokens)
}

/** 按 id 读取作品视图(v2 原生运行时接口):优先 book2 真源;缺则临时转换 v1 works 行(强制自动迁移前的过渡)。
 *  取代 loadWorkSmart/loadBook2AsWork 的 UI/引擎接口——消费方全部改用 BookView。 */
export async function loadWorkView(id: string): Promise<BookView | null> {
  const loaded = await loadBookDocWithMeta(id)
  if (loaded) {
    return buildBookView(loaded.doc, {
      id,
      source: 'book2',
      tokensUsed: loaded.meta.tokensUsed,
      updatedAt: loaded.meta.updatedAt
    })
  }
  const work = await getWork(id)
  if (!work) return null
  const doc = workToV2(work)
  return buildBookView(doc, {
    id,
    source: 'works',
    tokensUsed: work.tokensUsed,
    updatedAt: work.updatedAt ?? work.createdAt,
    syncStatus: work.syncStatus,
    sourceTaskId: work.sourceTaskId,
    overrides: {
      fulltext: work.chapters.map(c => c.content).join('\n'),
      ...(work.storyline?.length ? { storyline: work.storyline } : {})
    }
  })
}

/** 按 id 读取作品视图:优先 book2(v2 真源),缺则 works(v1)。返回 LocalWork 带 book2SourceId 表示来源。 */
export async function loadWorkSmart(id: string): Promise<LocalWork | null> {
  const b2 = await loadBook2AsWork(id)
  if (b2) return b2
  return getWork(id)
}

/** 把编辑后的人物卡写回 v2 作品:只重写 characters 表该作品的行 + books.charCount(单行粒度) */
export async function saveBook2Characters(id: string, cards: CharacterCard[]): Promise<void> {
  const characters: Record<string, BookCharacter> = {}
  for (const c of cards) {
    const bc = characterCardToBook(c)
    if (bc) characters[bc['姓名']] = bc
  }
  await db.transaction('rw', db.books, db['book-characters'], async () => {
    const meta = await db.books.get(id)
    if (!meta) throw new Error('本地未找到该 v2 作品')
    meta.manifest = { ...meta.manifest, charCount: Object.keys(characters).length }
    meta.updatedAt = nowIso()
    await db['book-characters'].where('id').equals(id).delete()
    await db['book-characters'].bulkPut(Object.entries(characters).map(([name, card]) => ({ id, name, card })))
    await db.books.put(meta)
  })
}

/** 读取-修改-写回:v2 真源更新的通用入口(分段文本/manifest/角色层等小编辑共用)。
 *  mutate 同步修改 BookDoc,返回 false 表示无变更跳过写回(缺省/true 均写回);作品不存在时抛错。 */
export async function updateBook2(id: string, mutate: (doc: BookDoc) => boolean | undefined): Promise<void> {
  const loaded = await loadBookDocWithMeta(id)
  if (!loaded) throw new Error('本地未找到该 v2 作品')
  const changed = mutate(loaded.doc)
  if (changed !== false) await saveBookDoc(id, loaded.doc)
}

/** 只写引擎派生数据(books.updatedAt + book-world 单行;arcs 写回等专用,不触碰段/卡/正文)。
 *  world 为空/无有效字段时删除 world 行;作品不存在时抛错。 */
export async function updateBook2World(id: string, world: BookDoc['world']): Promise<void> {
  await db.transaction('rw', db.books, db['book-world'], async () => {
    const meta = await db.books.get(id)
    if (!meta) throw new Error('本地未找到该 v2 作品')
    meta.updatedAt = nowIso()
    await db.books.put(meta)
    const has = !!(world && (world.entities || world.conflicts?.length || world.characterArcs?.length))
    if (has) await db['book-world'].put({ id, world: world! })
    else await db['book-world'].delete(id)
  })
}

/** 写回世界概览元数据(overview 编辑;只动 books 行的 manifest,段落与角色层不受影响) */
export async function saveBook2Meta(
  id: string,
  meta: Partial<Pick<BookDoc['manifest'], 'summary' | 'genre' | 'orientation' | 'heat' | 'setting' | 'tags' | 'contentWarnings' | 'tropes'>>
): Promise<void> {
  await db.transaction('rw', db.books, async () => {
    const row = await db.books.get(id)
    if (!row) throw new Error('本地未找到该 v2 作品')
    row.manifest = { ...row.manifest, ...meta }
    row.updatedAt = nowIso()
    await db.books.put(row)
  })
}

/** 导出/备份用:从库内现打包 v2 zip(库内是结构化行,zip 只在边界序列化) */
export async function loadBook2RawZip(id: string): Promise<Uint8Array | null> {
  const loaded = await loadBookDocWithMeta(id)
  if (!loaded) return null
  try {
    return bookDocToZip(loaded.doc)
  } catch {
    return null
  }
}

/** 导入 v2 分享包 zip:解析拆行入库(新鲜 id,与来源不冲突)并返回作品视图;非 aisb-book 格式抛错 */
export async function importBook2Zip(bytes: Uint8Array, id = uuid()): Promise<LocalWork> {
  const doc = bookZipToDoc(bytes)
  await saveBookDoc(id, doc)
  const work = await loadBook2AsWork(id)
  if (!work) throw new Error('v2 分享包导入后无法读取')
  return work
}

/** 列目录:返回所有 v2 作品的元数据行(books 表直读,不解包;按最后操作时间倒序) */
export async function listBook2(): Promise<BookMetaRow[]> {
  if (typeof indexedDB === 'undefined') return []
  return (await db.books.toArray())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 删除一部 v2 作品(四表联动,一个事务) */
export async function deleteBook2(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.transaction('rw', db.books, db['book-segments'], db['book-characters'], db['book-world'], async () => {
    await Promise.all([
      db.books.delete(id),
      db['book-segments'].where('id').equals(id).delete(),
      db['book-characters'].where('id').equals(id).delete(),
      db['book-world'].delete(id)
    ])
  })
}
