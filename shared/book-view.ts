// shared/book-view.ts
// 运行时视图 BookView(v2 原生):引擎与界面的统一读取接口。
// 取代旧 LocalWork 视图——边界全部是 v2 类型(manifest/BookCharacter/SegmentDir/BookWorld),
// 人物卡语义经唯一解释器 interpretCharacter 归一(profile 自由区随卡);不再有 v1 形状的视图模型。
// 纯函数,前后端共用;见 docs/format-v2.md §8/§10.0。
import type { BookDoc, BookWorld, SegmentDir, AisbBookManifest } from './novel-v2'
import type { CharacterCard, StoryBeat } from './novel'
import { interpretCharacters } from './character-interpreter'

/** v2 原生运行时视图 */
export interface BookView {
  id: string
  /** 真源:book2=原生 v2;works=v1 行临时转换(强制自动迁移前的过渡) */
  source: 'book2' | 'works'
  manifest: AisbBookManifest
  title: string
  author?: string
  /** v2 文档本体(段/角色/派生数据都在这里;编辑经 bookStoreV2.updateBook2 写回) */
  doc: BookDoc
  /** 归档全文(阅读器用;works 源为拼接全文) */
  fulltext: string
  /** 段列表(按 canon.index 升序,下标与 storyline/游戏 plotBeat 对齐) */
  segments: SegmentDir[]
  /** 角色语义卡(单一解释器产物:引擎语义字段 + profile 自由区随卡) */
  characters: CharacterCard[]
  /** 引擎派生数据随包(实体库/冲突/配角弧线) */
  world: BookWorld
  /** 段轨道(引擎 track 窗口用,下标对齐 segments;startChar 仅 works 源有意义) */
  storyline: StoryBeat[]
  /** 来源云端任务 id(仅 works 源过渡期存在,任务已安装判定用) */
  sourceTaskId?: string
  /** 云端同步标记(仅 works 源过渡期存在;book2 真源无云端行) */
  syncStatus?: 'local' | 'synced' | 'dirty'
  updatedAt: string
  tokensUsed?: number
  /** 归档正文字符数(books 行维护;texts:false 窄读取时仍可展示字数/判定空正文) */
  textChars?: number
}

export interface BuildBookViewOptions {
  id: string
  source: 'book2' | 'works'
  updatedAt?: string
  tokensUsed?: number
  syncStatus?: 'local' | 'synced' | 'dirty'
  sourceTaskId?: string
  /** 归档正文字符数(books 行维护;texts:false 窄读取时仍回传) */
  textChars?: number
  /** works 源覆盖:真 v1 行的正文/段轨道带真实 startChar;book2 源不需传 */
  overrides?: { fulltext?: string, storyline?: StoryBeat[] }
}

/** BookDoc → BookView(v2 原生运行时视图;纯函数) */
export function buildBookView(doc: BookDoc, opts: BuildBookViewOptions): BookView {
  const segments = Object.values(doc.segments).sort((a, b) => a.canon.index - b.canon.index)
  // 段轨道:works 源用真 v1 行的 storyline(带 startChar);book2 源由正典派生(startChar 恒 0,窗口取 canon.text)
  const storyline: StoryBeat[] = opts.overrides?.storyline?.length
    ? opts.overrides.storyline
    : segments.map((seg, i) => ({
        index: i,
        startChar: 0,
        label: seg.canon.title ?? `第${i + 1}段`,
        summary: seg.canon.beat,
        cast: seg.canon.cast ?? [],
        place: seg.canon.place ?? null,
        turn: seg.canon.turn ?? null,
        hook: seg.canon.hook ?? null
      }))
  // 角色语义卡:唯一解释器;profile 自由区随卡(引擎「补充设定」/编辑器自由区共用)
  const characters = interpretCharacters(doc.characters).map(({ card, profile }) => {
    if (Object.keys(profile).length) card.profile = profile
    return card
  })
  const world: BookWorld = doc.world ?? {}
  return {
    id: opts.id,
    source: opts.source,
    manifest: doc.manifest,
    title: doc.manifest.title,
    ...(doc.manifest.author ? { author: doc.manifest.author } : {}),
    doc,
    fulltext: opts.overrides?.fulltext ?? doc.fulltext,
    segments,
    characters,
    world,
    storyline,
    ...(opts.syncStatus ? { syncStatus: opts.syncStatus } : {}),
    updatedAt: opts.updatedAt ?? new Date().toISOString(),
    ...(opts.tokensUsed ? { tokensUsed: opts.tokensUsed } : {}),
    ...(opts.textChars ? { textChars: opts.textChars } : {})
  }
}
