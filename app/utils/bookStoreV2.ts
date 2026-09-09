// app/utils/bookStoreV2.ts
// 作品格式 v2(aisb-book)本地存储:IndexedDB 结构化表族(v14:books/book-texts/book-segments/
// book-seg-chars/book-characters/book-world/book-stats)。库内是结构化行;zip 只在边界序列化
// (导入分享包、导出/备份/分享时现打包),读写不再反复解包/重打包。
//  - 保存:BookDoc → 拆行(一个事务);行 id 用 uuid,与旧 works 的 id 体系一致(BookDoc 本身不带 id)
//  - 读取:并行查表 → 内存拼装 BookDoc;可按需转换为 LocalWork(经 v2-convert)给旧引擎/旧界面
//  - 粒度(大字段原子化):正文在 book-texts 单行、段角色文件在 book-seg-chars 单行——
//    改 meta/charCount/弧线/单个段角色文件都是小行写入,不再出现"动一处搬一片"
import { db, type BookMetaRow, type BookSegmentRow, type BookCharacterRow, type BookWorldRow, type BookStatsRow, type BookTextRow, type BookSegCharRow, bookFullTextKey, bookSegTextKey, bookSegCharKey } from './localDb'
import { bookDocToZip, bookZipToDoc, type BookDoc, type BookCharacter, type SegmentCharacterFile } from '#shared/novel-v2'
import { v2ToWork, workToV2 } from '#shared/v2-convert'
import { uuid } from '#shared/novel'
import type { CharacterArc, LocalWork, CharacterCard } from '#shared/novel'
import { characterCardToBook } from '#shared/normalize-card'
import { buildBookView, type BookView } from '#shared/book-view'
import { getWork, getWorkTokensUsed, touchWork, addWorkTokens } from './worldGen'

const nowIso = () => new Date().toISOString()

/** BookDoc → 行族(拆解;一个事务内写入;正文/段角色文件各自独立成行) */
async function saveBookDoc(id: string, doc: BookDoc): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const meta: BookMetaRow = {
    id,
    title: doc.manifest.title,
    ...(doc.manifest.author ? { author: doc.manifest.author } : {}),
    updatedAt: nowIso(),
    manifest: doc.manifest,
    textChars: doc.fulltext.length,
    ...(doc.games && Object.keys(doc.games).length > 0 ? { games: doc.games } : {})
  }
  const textRows: BookTextRow[] = [{ key: bookFullTextKey(id), id, text: doc.fulltext }]
  const segRows: BookSegmentRow[] = []
  const segCharRows: BookSegCharRow[] = []
  for (const [key, dir] of Object.entries(doc.segments)) {
    const seq = Number.parseInt(key, 10) || 0
    segRows.push({ id, key, seq, canon: { ...dir.canon, text: '' } })
    // 段正文独立成行(与元数据/角色文件解耦;段被单独编辑过时与归档全文是两份受控副本)
    textRows.push({ key: bookSegTextKey(id, seq), id, text: dir.canon.text })
    for (const [name, file] of Object.entries(dir.characters)) {
      segCharRows.push({ key: bookSegCharKey(id, seq, name), id, seq, name, file })
    }
  }
  const charRows: BookCharacterRow[] = Object.entries(doc.characters).map(([name, card]) => ({ id, name, card }))
  const worldRow: BookWorldRow = { id, ...(doc.world ? { world: doc.world } : {}) }
  await db.transaction('rw', [db.books, db['book-texts'], db['book-segments'], db['book-seg-chars'], db['book-characters'], db['book-world']], async () => {
    await Promise.all([
      db['book-texts'].where('id').equals(id).delete(),
      db['book-segments'].where('id').equals(id).delete(),
      db['book-seg-chars'].where('id').equals(id).delete(),
      db['book-characters'].where('id').equals(id).delete(),
      db['book-world'].delete(id)
    ])
    await Promise.all([
      db.books.put(meta),
      db['book-texts'].bulkPut(textRows),
      db['book-segments'].bulkPut(segRows),
      db['book-seg-chars'].bulkPut(segCharRows),
      db['book-characters'].bulkPut(charRows),
      ...(doc.world ? [db['book-world'].put(worldRow)] : [])
    ])
  })
}

/** 行族 → BookDoc(拼装;纯内存,不解压)。stats 行(高频标量)一并带出,供 token 展示。
 *  opts.texts=false 跳过 book-texts 查询(正文行不拉;canon.text/fulltext 为空串)——
 *  供只需要卡/正典元数据/弧线的场景(如角色卡编辑弹窗),大书少拉几百行正文 */
async function loadBookDocWithMeta(id: string, opts?: { texts?: boolean }): Promise<{ doc: BookDoc, meta: BookMetaRow, stats: BookStatsRow | undefined } | null> {
  if (typeof indexedDB === 'undefined') return null
  const wantTexts = opts?.texts !== false
  const [meta, textRows, segRows, segCharRows, charRows, worldRow, stats] = await Promise.all([
    db.books.get(id),
    wantTexts ? db['book-texts'].where('id').equals(id).toArray() : Promise.resolve([] as BookTextRow[]),
    db['book-segments'].where('id').equals(id).toArray(),
    db['book-seg-chars'].where('id').equals(id).toArray(),
    db['book-characters'].where('id').equals(id).toArray(),
    db['book-world'].get(id),
    db['book-stats'].get(id)
  ])
  if (!meta) return null
  const segText = new Map<number, string>()
  for (const t of textRows) {
    if (t.key === bookFullTextKey(id)) continue
    // key 形如 `${id}::seg::${seq}`
    const seq = Number.parseInt(t.key.slice((`${id}::seg::`).length), 10)
    if (Number.isFinite(seq)) segText.set(seq, t.text)
  }
  const fullRow = textRows.find(t => t.key === bookFullTextKey(id))
  const segChars: Record<string, Record<string, SegmentCharacterFile>> = {}
  for (const r of segCharRows) {
    ;(segChars[r.seq] ??= {})[r.name] = r.file
  }
  const segments: BookDoc['segments'] = {}
  for (const r of [...segRows].sort((a, b) => a.seq - b.seq)) {
    segments[r.key] = { canon: { ...r.canon, text: segText.get(r.seq) ?? '' }, characters: segChars[r.seq] ?? {} }
  }
  const characters: Record<string, BookCharacter> = {}
  for (const r of charRows) characters[r.name] = r.card
  const doc: BookDoc = {
    manifest: meta.manifest,
    fulltext: fullRow?.text ?? '',
    segments,
    characters,
    ...(worldRow?.world ? { world: worldRow.world } : {}),
    ...(meta.games && Object.keys(meta.games).length > 0 ? { games: meta.games } : {})
  }
  return { doc, meta, stats }
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
  // 游玩消耗累计在 book-stats 行级字段(不进 zip),读取视图映射到 LocalWork 供书架卡片展示
  if (loaded.stats?.tokensUsed) w.tokensUsed = (w.tokensUsed ?? 0) + loaded.stats.tokensUsed
  return w
}

/** 刷新 v2 作品的最后操作时间(书架排序;单行更新) */
export async function touchBook2(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.books.update(id, { updatedAt: nowIso() })
}

/** 游玩消耗累计( book-stats 行级字段,不触碰 books 全行——IndexedDB 无部分更新,
 *  改 books 行会整本 fulltext 搬移,而本函数每回合 AI 调用都会触发) */
export async function addBook2Tokens(id: string, tokens: number): Promise<void> {
  if (typeof indexedDB === 'undefined' || tokens <= 0) return
  await db.transaction('rw', db['book-stats'], async () => {
    const row = await db['book-stats'].get(id)
    await db['book-stats'].put({ id, tokensUsed: (row?.tokensUsed ?? 0) + tokens })
  })
}

/** 智能触碰:v2 作品走 books 行,旧 v1 作品走 works 行(阅读/进游戏时刷新排序) */
export async function touchWorkSmart(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  if (await db.books.get(id)) return touchBook2(id)
  return touchWork(id)
}

/** 智能消耗累计:v2 作品走 book-stats 小行,旧 v1 作品走 works 旁路计量(v14 加速),失败静默 */
export async function addWorkTokensSmart(id: string, tokens: number): Promise<void> {
  if (typeof indexedDB === 'undefined' || tokens <= 0) return
  if (await db.books.get(id)) return addBook2Tokens(id, tokens)
  return addWorkTokens(id, tokens)
}

/** 按 id 读取作品视图(v2 原生运行时接口):优先 book2 真源;缺则临时转换 v1 works 行(强制自动迁移前的过渡)。
 *  取代 loadWorkSmart/loadBook2AsWork 的 UI/引擎接口——消费方全部改用 BookView。
 *  opts.texts=false 跳过正文行查询(编辑器等只用卡/正典元数据的场景);v1 路径忽略该选项 */
export async function loadWorkView(id: string, opts?: { texts?: boolean }): Promise<BookView | null> {
  const loaded = await loadBookDocWithMeta(id, opts)
  if (loaded) {
    return buildBookView(loaded.doc, {
      id,
      source: 'book2',
      tokensUsed: loaded.stats?.tokensUsed,
      updatedAt: loaded.meta.updatedAt,
      textChars: loaded.meta.textChars ?? (loaded.doc.fulltext.length || undefined)
    })
  }
  const work = await getWork(id)
  if (!work) return null
  const doc = workToV2(work)
  return buildBookView(doc, {
    id,
    source: 'works',
    // v1 计量 = 行内值与旁路小表值取大者(addWorkTokens 旁路累加,不再整书重写)
    tokensUsed: await getWorkTokensUsed(id),
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

/** 两份段角色文件是否等价(null 视为同一) */
function sameSegFile(a: unknown, b: unknown): boolean {
  const na = a ?? null
  const nb = b ?? null
  if (!na && !nb) return true
  return JSON.stringify(na) === JSON.stringify(nb)
}

/** 编辑角色卡弹窗统一写回(单事务,多表原子;取代 saveBook2Characters+flushSegEdits+updateBook2World 三连):
 *  - cards:全量人物卡列表(整层替换,列表语义);
 *  - segWork:弹窗的段工作副本(segments 部分),与库内逐 (段,角色)/(canon) diff——只写有差异的行
 *    (原子粒度,不搬段正文/其他角色);
 *  - characterArcs:只替换 world 行的 characterArcs 键,entities/conflicts 取库内现值
 *    (不再用打开弹窗时的旧快照整行覆盖,游玩期间写入的实体库/冲突不会被抹掉);
 *  - renames:本次改名对——world 派生层(实体库角色名+别名、角色类冲突 entityName)同步重映射。
 *  作品不存在时抛错;任一步失败整体回滚,不留半截状态。 */
export async function saveBook2Edits(
  id: string,
  edits: { cards: CharacterCard[], segWork?: BookDoc['segments'], characterArcs?: CharacterArc[], renames?: { from: string, to: string }[] }
): Promise<void> {
  const characters: Record<string, BookCharacter> = {}
  for (const c of edits.cards) {
    const bc = characterCardToBook(c)
    if (bc) characters[bc['姓名']] = bc
  }
  await db.transaction('rw', db.books, db['book-segments'], db['book-seg-chars'], db['book-characters'], db['book-world'], async () => {
    const meta = await db.books.get(id)
    if (!meta) throw new Error('本地未找到该 v2 作品')
    // 人物卡:整层替换(列表语义,含删除)
    await db['book-characters'].where('id').equals(id).delete()
    await db['book-characters'].bulkPut(Object.entries(characters).map(([name, card]) => ({ id, name, card })))
    // 正典/段角色文件:逐段 diff——canon(如改名迁移改写的 cast/主角)与角色文件各自独立成行写回
    if (edits.segWork) {
      for (const [key, workSeg] of Object.entries(edits.segWork)) {
        if (!workSeg) continue
        const seq = Number.parseInt(key, 10) || 0
        const row = await db['book-segments'].get([id, seq])
        if (row && JSON.stringify(row.canon) !== JSON.stringify(workSeg.canon)) {
          await db['book-segments'].put({ ...row, canon: { ...workSeg.canon, text: '' } })
        }
        const prefix = `${id}::${seq}::`
        const liveRows = await db['book-seg-chars'].where('key').between(prefix, `${prefix}\uffff`).toArray()
        const liveByName = new Map(liveRows.map(r => [r.name, r.file]))
        const names = new Set([...liveByName.keys(), ...Object.keys(workSeg.characters)])
        for (const name of names) {
          const wf = workSeg.characters[name]
          if (sameSegFile(liveByName.get(name), wf)) continue
          if (!wf || Object.keys(wf).length <= 1) {
            // 只有姓名键(空档):删除该行
            await db['book-seg-chars'].delete(bookSegCharKey(id, seq, name))
          } else {
            await db['book-seg-chars'].put({ key: bookSegCharKey(id, seq, name), id, seq, name, file: JSON.parse(JSON.stringify(wf)) as SegmentCharacterFile })
          }
        }
      }
    }
    // world 行:读库内现值,替换 characterArcs 键;改名对同步重映射派生层的角色引用
    // (实体库角色名+别名、角色类冲突 entityName);空弧线且无实体/冲突时不落空行
    if (edits.characterArcs || edits.renames?.length) {
      const worldRow = await db['book-world'].get(id)
      const world = { ...(worldRow?.world ?? {}), ...(edits.characterArcs ? { characterArcs: edits.characterArcs } : {}) }
      for (const { from, to } of edits.renames ?? []) {
        const fk = from.replace(/\s+/g, '')
        for (const c of world.entities?.characters ?? []) {
          if (c.name.replace(/\s+/g, '') === fk) c.name = to
          if (Array.isArray(c.alias)) c.alias = c.alias.map(a => (a === from ? to : a))
        }
        for (const cf of world.conflicts ?? []) {
          if (cf.entityType === 'character' && cf.entityName === from) cf.entityName = to
        }
      }
      const has = !!(world.entities || world.conflicts?.length || world.characterArcs?.length)
      if (has) await db['book-world'].put({ id, world })
      else if (worldRow) await db['book-world'].delete(id)
    }
    meta.manifest = { ...meta.manifest, charCount: Object.keys(characters).length }
    meta.updatedAt = nowIso()
    await db.books.put(meta)
  })
}

/** 读取-修改-写回:v2 真源更新的通用兜底入口(少量无专用入口的编辑用)。
 *  注意:本函数走"拼装-改-整写"(含正文/段行整体重建),正文与段正文编辑请优先用
 *  saveBook2Fulltext / saveBook2SegmentText 单行入口;作品不存在时抛错。 */
export async function updateBook2(id: string, mutate: (doc: BookDoc) => boolean | undefined): Promise<void> {
  const loaded = await loadBookDocWithMeta(id)
  if (!loaded) throw new Error('本地未找到该 v2 作品')
  const changed = mutate(loaded.doc)
  if (changed !== false) await saveBookDoc(id, loaded.doc)
}

/** 归档全文单行写回(edit 页正文编辑;可选同步 manifest 书名/作者,meta 行 KB 级)。
 *  全文/段正文任一变更都会使 segStarts 失效:清该键,下次导出自动回退内嵌格式 */
export async function saveBook2Fulltext(
  id: string,
  text: string,
  metaPatch?: { title?: string, author?: string | null }
): Promise<void> {
  await db.transaction('rw', db.books, db['book-texts'], async () => {
    const meta = await db.books.get(id)
    if (!meta) throw new Error('本地未找到该 v2 作品')
    await db['book-texts'].put({ key: bookFullTextKey(id), id, text })
    meta.textChars = text.length
    if (metaPatch?.title) {
      meta.manifest = { ...meta.manifest, title: metaPatch.title }
      meta.title = metaPatch.title
    }
    if (metaPatch && 'author' in metaPatch) {
      const a = metaPatch.author
      if (a) {
        meta.manifest = { ...meta.manifest, author: a }
        meta.author = a
      } else {
        const { author: _drop, ...rest } = meta.manifest
        meta.manifest = rest
        delete meta.author
      }
    }
    meta.manifest = { ...meta.manifest, segStarts: undefined } as typeof meta.manifest
    meta.updatedAt = nowIso()
    await db.books.put(meta)
  })
}

/** 段正文单行写回(SegmentsModal;段行/角色文件/其他段不受影响)。segStarts 同上失效 */
export async function saveBook2SegmentText(id: string, segKey: string, text: string): Promise<void> {
  const seq = Number.parseInt(segKey, 10) || 0
  await db.transaction('rw', db.books, db['book-texts'], async () => {
    const meta = await db.books.get(id)
    if (!meta) throw new Error('本地未找到该 v2 作品')
    await db['book-texts'].put({ key: bookSegTextKey(id, seq), id, text })
    meta.manifest = { ...meta.manifest, segStarts: undefined } as typeof meta.manifest
    meta.updatedAt = nowIso()
    await db.books.put(meta)
  })
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

/** 按 id 判断 v2 作品是否已落库(单行 get,不做整书拼装;安装查重用) */
export async function hasBook2(id: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  return (await db.books.get(id)) != null
}

/** 删除一部 v2 作品(全部相关表联动,一个事务) */
export async function deleteBook2(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.transaction('rw', [db.books, db['book-texts'], db['book-segments'], db['book-seg-chars'], db['book-characters'], db['book-world'], db['book-stats']], async () => {
    await Promise.all([
      db.books.delete(id),
      db['book-texts'].where('id').equals(id).delete(),
      db['book-segments'].where('id').equals(id).delete(),
      db['book-seg-chars'].where('id').equals(id).delete(),
      db['book-characters'].where('id').equals(id).delete(),
      db['book-world'].delete(id),
      db['book-stats'].delete(id)
    ])
  })
}
