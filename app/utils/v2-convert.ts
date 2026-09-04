// app/utils/v2-convert.ts
// aisb-share v1(LocalWork) ↔ 作品格式 v2(BookDoc) 双向转换(方案 B:存储层 v2,运行时仍输出 LocalWork)。
//  - v1 → v2:章节全文拼接 → 归档 <书名>.txt;按字数切段 → 每段正典;overlay/entities 归一 → characters;storyline cast 建段角色文件。
//  - v2 → v1:把 v2 还原为 LocalWork(旧引擎/旧界面兼容读取)。
// 见 docs/format-v2.md §8(转换器与兼容策略)。
import type { LocalWork, CharacterCard, ChapterSegment, StoryBeat } from '#shared/novel'
import type { BookDoc, BookCharacter, SegmentCanon, SegmentCharacterFile, AisbBookManifest } from '#shared/novel-v2'
import { BOOK2_FORMAT, BOOK2_VERSION } from '#shared/novel-v2'
import { characterCardToBook } from '#shared/normalize-card'

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
    setting: work.overlay?.setting
  }

  return { manifest, fulltext, segments, characters }
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
    const canon: SegmentCanon = {
      index: i,
      ...(beat.label ? { title: beat.label } : {}),
      cast: beat.cast ?? [],
      beat: beat.summary ?? '',
      ...(beat.place ? { place: beat.place } : {}),
      ...(beat.turn ? { turn: beat.turn } : {}),
      ...(beat.hook ? { hook: beat.hook } : {}),
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
      canon: { index: idx, cast: [], beat: '', text: segText },
      characters: {}
    }
  }
  if (idx === 0) segments['000'] = { canon: { index: 0, cast: [], beat: '', text: '' }, characters: {} }
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

  // storyline:从 segments 正典还原
  const storyline: StoryBeat[] = Object.values(doc.segments)
    .sort((a, b) => a.canon.index - b.canon.index)
    .map((seg, i) => {
      const c = seg.canon
      return {
        index: i,
        startChar: 0, // 无法从 v2 精确还原 startChar;由读取层按需重算
        label: c.title ?? `第${i + 1}段`,
        summary: c.beat,
        cast: c.cast ?? [],
        place: c.place ?? null,
        turn: c.turn ?? null,
        hook: c.hook ?? null
      }
    })

  const now = base.createdAt ?? new Date().toISOString()
  return {
    id: base.id,
    title: m.title,
    author: m.author,
    createdAt: now,
    updatedAt: base.updatedAt ?? now,
    chapters,
    syncStatus: 'local',
    worldFormat: 2,
    overlay: {
      title: m.title,
      summary: undefined,
      characters: characters.length ? characters : undefined,
      tags: m.tags,
      orientation: m.orientation,
      setting: m.setting,
      heat: m.heat
    },
    storyline: storyline.length ? storyline : undefined,
    entities: undefined, // v2 不含完整实体库(合并层产物);如需要可后续补
    conflicts: undefined,
    warnings: undefined
  }
}

/** BookCharacter → CharacterCard(英文键,供旧引擎读取) */
export function bookCharacterToCard(bc: BookCharacter): CharacterCard | undefined {
  if (!bc['姓名']?.trim()) return undefined
  const personalityRaw: unknown = bc['性格']
  const card: CharacterCard = {
    name: bc['姓名'].trim(),
    role: typeof bc['角色'] === 'string' && bc['角色'].trim() ? bc['角色'].trim() : '配角',
    personality: Array.isArray(personalityRaw)
      ? (personalityRaw as unknown[]).filter((x): x is string => typeof x === 'string')
      : (typeof personalityRaw === 'string' ? (personalityRaw as string).split(/[、，,;；]/).map(s => s.trim()).filter(Boolean) : [])
  }
  const set = (k: 'identity' | 'appearance' | 'background' | 'alias' | 'first_appearance', v: unknown, type: 'text' | 'list') => {
    const val = type === 'text'
      ? (typeof v === 'string' ? v : Array.isArray(v) ? v.filter(x => typeof x === 'string').join('；') : typeof v === 'object' && v ? JSON.stringify(v) : null)
      : (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? (v as string).split(/[、，,;；]/).map(s => s.trim()).filter(Boolean) : undefined)
    if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && !val.length)) (card as unknown as Record<string, unknown>)[k] = val
  }
  set('identity', bc['身份'], 'text')
  set('appearance', bc['外貌'], 'text')
  set('background', bc['背景'], 'text')
  set('alias', bc['别名'], 'text')
  set('first_appearance', bc['首次出场'], 'text')
  card.speech_style = Array.isArray(bc['说话风格']) ? bc['说话风格'] : undefined
  card.abilities = Array.isArray(bc['能力']) ? bc['能力'] : undefined
  card.goals = Array.isArray(bc['目标']) ? bc['目标'] : undefined
  card.fears = Array.isArray(bc['恐惧']) ? bc['恐惧'] : undefined
  card.secrets = Array.isArray(bc['秘密']) ? bc['秘密'] : undefined
  if (Array.isArray(bc['关系'])) {
    const rels = bc['关系'].flatMap((r): { name: string, type: string, value: number }[] => {
      if (!r || typeof r !== 'object') return []
      const name = typeof r['对象'] === 'string' ? r['对象'] : ''
      if (!name) return []
      return [{ name, type: typeof r['说明'] === 'string' ? r['说明'] : '', value: typeof r['值'] === 'number' ? r['值'] : 0 }]
    })
    if (rels.length) card.relationships = rels
  }
  const n = (v: unknown): number | null | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  card.patience = n(bc['耐心']) ?? undefined
  card.softness = n(bc['心软']) ?? undefined
  card.desire = n(bc['性欲强度']) ?? undefined
  if (typeof bc['已死亡'] === 'boolean') card.dead = bc['已死亡']
  if (Array.isArray(bc['玩法喜好'])) card.kinks = bc['玩法喜好'].flatMap((k): { theme: string, view: string | null, role: string | null, detail: string | null }[] => {
    if (!k || typeof k !== 'object') return []
    const theme = typeof k['主题'] === 'string' ? k['主题'] : ''
    if (!theme) return []
    return [{ theme, view: typeof k['态度'] === 'string' ? k['态度'] : null, role: typeof k['角色'] === 'string' ? k['角色'] : null, detail: typeof k['细节'] === 'string' ? k['细节'] : null }]
  })
  if (bc['成人属性'] && typeof bc['成人属性'] === 'object') card.sex = bc['成人属性'] as CharacterCard['sex']
  // 未识别键 → profile(自由区,cardBrief 注入 AI「补充设定」)
  const consumed = new Set(['姓名', '角色', '身份', '外貌', '性格', '背景', '目标', '关系', '别名', '性别', '年龄', '说话风格', '能力', '恐惧', '弱点', '秘密', '首次出场', '已死亡', '耐心', '心软', '性欲强度', '玩法喜好', '成人属性', '弧线'])
  const profile: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(bc)) {
    if (!consumed.has(k)) profile[k] = v
  }
  if (Object.keys(profile).length) card.profile = profile
  return card
}
