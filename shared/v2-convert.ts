// shared/v2-convert.ts
// aisb-share v1(LocalWork) ↔ 作品格式 v2(BookDoc) 双向转换(方案 B:存储层 v2,运行时仍输出 LocalWork)。
//  - v1 → v2:章节全文拼接 → 归档 <书名>.txt;按字数切段 → 每段正典;overlay/entities 归一 → characters;storyline cast 建段角色文件;
//    entities/conflicts/characterArcs(引擎派生数据)随包存 world.json,保证往返无损。
//  - v2 → v1:把 v2 还原为 LocalWork(旧引擎/旧界面兼容读取;服务端 download/promote 亦用)。
// 见 docs/format-v2.md §8(转换器与兼容策略)。纯函数,前后端共用。
import type { LocalWork, CharacterCard, ChapterSegment, StoryBeat } from './novel'
import type { BookDoc, BookCharacter, SegmentCanon, SegmentCharacterFile, AisbBookManifest } from './novel-v2'
import { BOOK2_FORMAT, BOOK2_VERSION } from './novel-v2'
import { characterCardToBook } from './normalize-card'
import { interpretCharacter } from './character-interpreter'

/** LocalWork → BookDoc:把 v1 作品转成 v2 目录(含切段) */
export function workToV2(work: LocalWork): BookDoc {
  const fulltext = chaptersToText(work.chapters)
  // 段:优先用 storyline(细纲段),否则按字数粗切
  const storyline = work.storyline ?? []
  const segments = storyline.length > 0
    ? storylineToSegments(storyline, work)
    : splitToSegments(work.chapters)

  // characters/:overlay.characters 归一成中文保留键卡
  const characters: Record<string, BookCharacter> = {}
  for (const c of (work.overlay?.characters ?? [])) {
    const bc = characterCardToBook(c)
    if (bc) characters[bc['姓名']] = bc
  }

  const manifest: AisbBookManifest = {
    format: BOOK2_FORMAT,
    version: BOOK2_VERSION,
    kind: 'book',
    title: work.title,
    ...(work.author ? { author: work.author } : {}),
    segmentCount: Object.keys(segments).length,
    charCount: Object.keys(characters).length,
    tags: work.overlay?.tags,
    orientation: work.overlay?.orientation,
    heat: work.overlay?.heat,
    setting: work.overlay?.setting,
    summary: work.overlay?.summary,
    genre: work.overlay?.genre,
    contentWarnings: work.overlay?.contentWarnings,
    tropes: work.overlay?.tropes
  }

  return {
    manifest,
    fulltext,
    segments,
    characters,
    // 引擎派生数据随包(实体库/冲突/配角弧线):读取层尚未全部现拼,随包携带保证功能不回退
    ...((work.entities || work.conflicts?.length || work.characterArcs?.length)
      ? { world: { entities: work.entities, conflicts: work.conflicts, characterArcs: work.characterArcs } }
      : {})
  }
}

/** 拼全文 */
function chaptersToText(chapters: ChapterSegment[]): string {
  return chapters.map(c => c.content).join('\n')
}

/** 用 storyline 段生成 segments(每段正典 + 该段 cast 角色文件) */
function storylineToSegments(storyline: StoryBeat[], work: LocalWork): BookDoc['segments'] {
  const segments: BookDoc['segments'] = {}
  const fulltext = chaptersToText(work.chapters)
  storyline.forEach((beat, i) => {
    const segStart = Math.max(0, beat.startChar ?? 0)
    const canon: SegmentCanon = {
      index: i,
      ...(beat.label ? { title: beat.label } : {}),
      cast: beat.cast ?? [],
      beat: beat.summary ?? '',
      ...(beat.place ? { place: beat.place } : {}),
      ...(beat.turn ? { turn: beat.turn } : {}),
      ...(beat.hook ? { hook: beat.hook } : {}),
      start: segStart,
      text: sliceAt(fulltext, beat.startChar ?? 0, beat.startChar != null ? (storyline[i + 1]?.startChar ?? fulltext.length) - beat.startChar : fulltext.length - (beat.startChar ?? 0))
    }
    const chars: Record<string, SegmentCharacterFile> = {}
    for (const name of (beat.cast ?? [])) {
      // 仅建有本段可用内容的角色文件(chapterVariants 本段状态);仅出场、无状态的角色不建文件,
      // 留在正典 cast 里(空壳不落盘,见 docs/format-v2.md §3.2/§11.4)
      const variant = (work.overlay?.characters ?? []).find(c => c.name === name)?.chapterVariants?.find(v => (v.stage ?? v.chapter) === i)
      const seg: SegmentCharacterFile = { 姓名: name }
      if (variant?.status) seg['状态'] = { 处境: variant.status }
      if (Object.keys(seg).length > 1) chars[name] = seg
    }
    segments[String(i).padStart(3, '0')] = { canon, characters: chars }
  })
  return segments
}

/** 按轻重字符切段(无 storyline 时的退路,复用 splitUnits 思路) */
function splitToSegments(chapters: ChapterSegment[]): BookDoc['segments'] {
  const fulltext = chaptersToText(chapters)
  const MAX = 6000
  const segments: BookDoc['segments'] = {}
  let idx = 0
  for (let start = 0; start < fulltext.length; start = start + MAX, idx++) {
    const segText = fulltext.slice(start, start + MAX)
    segments[String(idx).padStart(3, '0')] = {
      canon: { index: idx, cast: [], beat: '', start, text: segText },
      characters: {}
    }
  }
  if (idx === 0) segments['000'] = { canon: { index: 0, cast: [], beat: '', start: 0, text: '' }, characters: {} }
  return segments
}

/** 取 fulltext 中一段(带边界保护) */
function sliceAt(text: string, start: number, len: number): string {
  return text.slice(Math.max(0, start), Math.min(text.length, start + Math.max(0, len)))
}

/** BookDoc → LocalWork(还原 v1:全文字节按段拼接 + overlay/entities 还原为英文键) */
export function v2ToWork(doc: BookDoc, base: { id: string, createdAt?: string, updatedAt?: string }): LocalWork {
  const m = doc.manifest
  const chapters: ChapterSegment[] = doc.fulltext
    ? [{ title: '', content: doc.fulltext }]
    : [{ title: '', content: '' }]

  // overlay.characters:从 characters/ 中文键映射回 CharacterCard(简化地用 BookCharacter 直接透传,但转成英文键)
  const characters: CharacterCard[] = Object.values(doc.characters).map(bc => bookCharacterToCard(bc)).filter((c): c is CharacterCard => !!c)

  // storyline:从 segments 正典还原。startChar 取 canon.start(段起点)——否则置 0 会让
  // v1 消费端(原文窗口/再迁移切段)全部落在书首;旧文档无 start 时保持 0 兜底
  const storyline: StoryBeat[] = Object.values(doc.segments)
    .sort((a, b) => a.canon.index - b.canon.index)
    .map((seg, i) => {
      const c = seg.canon
      return {
        index: i,
        startChar: typeof c.start === 'number' ? c.start : 0,
        label: c.title ?? `第${i + 1}段`,
        summary: c.beat,
        cast: c.cast ?? [],
        place: c.place ?? null,
        turn: c.turn ?? null,
        hook: c.hook ?? null
      }
    })

  const now = base.createdAt ?? new Date().toISOString()
  // v2 段数据随视图透传(引擎读取层消费:状态浅覆盖/段级主角/节点进度;见 docs/format-v2.md §8)
  const v2Segments = Object.values(doc.segments).sort((a, b) => a.canon.index - b.canon.index)
  return {
    id: base.id,
    title: m.title,
    author: m.author,
    createdAt: now,
    updatedAt: base.updatedAt ?? now,
    chapters,
    syncStatus: 'local',
    worldFormat: 2,
    ...(v2Segments.length ? { v2Segments } : {}),
    overlay: {
      title: m.title,
      summary: m.summary,
      characters: characters.length ? characters : undefined,
      tags: m.tags,
      orientation: m.orientation,
      setting: m.setting,
      heat: m.heat,
      genre: m.genre,
      contentWarnings: m.contentWarnings,
      tropes: m.tropes
    },
    storyline: storyline.length ? storyline : undefined,
    entities: doc.world?.entities,
    conflicts: doc.world?.conflicts,
    characterArcs: doc.world?.characterArcs,
    warnings: undefined
  }
}

/** BookCharacter → CharacterCard(引擎语义卡,供旧引擎读取)。
 *  v2 原生化后这是唯一正向映射的薄封装:语义归一全部委托 character-interpreter 的
 *  interpretCharacter(单一映射,消除双份保留键规则);profile 自由区附在卡上随引擎注入。 */
export function bookCharacterToCard(bc: BookCharacter): CharacterCard | undefined {
  const parsed = interpretCharacter(bc)
  if (!parsed) return undefined
  const card = parsed.card
  if (Object.keys(parsed.profile).length) card.profile = parsed.profile
  return card
}
