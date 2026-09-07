// shared/book-build.ts
// 生成管线 v2 打包(docs/format-v2.md §6.2):把云端/浏览器管线的产物(合并实体 + 成书 + 故事线 + 弧线)
// 打包为作品格式 v2(aisb-book)BookDoc,含 AI 标转折(剧情段合并/转折标题/主角/节点[])的消息构造与归一。
// 纯函数,前后端共用;不做任何 AI 调用(调用方传 relay,如 server/utils/world-gen-pipeline 的 stepAnnotate)。
import { characterCardToBook } from './normalize-card'
import type { BookCharacter, BookDoc, SegmentNode } from './novel-v2'
import { BOOK2_FORMAT, BOOK2_VERSION } from './novel-v2'
import type { CharacterArc, CharacterCard, StoryBeat, WorldOverlay } from './novel'

// ---- AI 标转折(§3.0:AI 只在已有粗段上标注/合并,不重读全文、不给出字符切点) ----

/** 标转折结果:一个剧情段 = 相邻粗段的合并(单粗段也合法,可只含节点) */
export interface SegmentAnnotation {
  /** 合并的粗段下标(0-based,升序连续) */
  beats: number[]
  /** 剧情转折/时间点标题(如 相识期/恋爱期/婚后) */
  title?: string
  /** 本段叙事主角(姓名,可数组;无法判定省略) */
  protagonists?: string[]
  /** 事件里程碑描述(按发生顺序,详细句而非短标签) */
  nodes?: string[]
}

/** 标转折输入的粗段列表(只给细纲摘要,不给全文,省 token) */
export interface AnnotateBeat {
  index: number
  label: string
  summary: string
  cast: string[]
}

/** 标转折消息(分块调用:每块 ≤ ANNOTATE_CHUNK_BEATS 个粗段,合并只发生在块内) */
export function buildAnnotateMessages(
  title: string,
  beats: AnnotateBeat[],
  /** 上一块末粗段(分块标注时的衔接上下文):让模型知道前情,从新剧情段干净起步(跨块不合并) */
  prevTail?: { title?: string, summary?: string }
): { system: string, user: string } {
  const system = '你必须只输出一个合法的 JSON 对象。'
  const beatLines = beats.map(b =>
    `- 段${b.index}:${(b.summary || b.label || '').slice(0, 160)}${b.cast?.length ? `(出场:${b.cast.slice(0, 6).join('、')})` : ''}`
  ).join('\n')
  const prevPart = prevTail?.summary?.trim()
    ? `\n\n背景(不属于本块,仅作衔接参考):上一次标注结束于「${(prevTail.title || '上一剧情段').slice(0, 24)}」:${prevTail.summary.trim().slice(0, 140)}。本块从该情节之后继续,第一粗段应开始新的剧情段,不要回头改写或覆盖背景中已标注的内容。`
    : ''
  const user = `小说《${title}》已按字数切成若干粗段,每段一行(编号为粗段下标)。请按剧情转折/时间点把相邻粗段合并成"剧情段"(如 相识期/恋爱期/婚后/分手后),并为每个剧情段标注:
- beats:合并的粗段下标数组(升序连续;每段至少 1 个;全部粗段必须恰好归属一个剧情段)
- title:该剧情段的时间点标题(短词;不确定可省略)
- protagonists:该段叙事主角姓名(原文用名,1~2 人;不确定省略)
- nodes:该段内的事件里程碑(3~8 条,按发生顺序;每条一句完整描述,保留起因/经过/转折/结果,不要压缩成短标签)

粗段列表:
${beatLines}
${prevPart}
只输出 {"segments":[{"beats":[0,1],"title":"相识期","protagonists":["名"],"nodes":["事件…"]}]}。`
  return { system, user }
}

/** 名字归一(去空白) */
function nameKey(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, '').trim()
}

/** AI 标转折输出 → 合法 SegmentAnnotation 列表。
 *  容错:非法下标/重叠/遗漏的粗段自动落为单粗段剧情段;主角名与 cast 宽松匹配,匹配不上丢弃;无节点省略。 */
export function normalizeSegmentAnnotations(raw: unknown, beats: AnnotateBeat[]): SegmentAnnotation[] {
  const valid = new Set(beats.map(b => b.index))
  if (!valid.size) return []
  const castPool = new Set(beats.flatMap(b => (b.cast ?? []).map(nameKey)).filter(Boolean))
  const used = new Set<number>()
  const out: SegmentAnnotation[] = []
  const list = (raw as { segments?: unknown })?.segments
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const rec = item as { beats?: unknown, title?: unknown, protagonists?: unknown, nodes?: unknown }
      const idxs = Array.isArray(rec.beats)
        ? rec.beats.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && valid.has(i) && !used.has(i))
        : []
      if (idxs.length === 0) continue
      // 只接纳连续区间(剧情段 = 相邻粗段;跳跃的部分留给兜底单段)
      let contiguous = true
      for (let k = 1; k < idxs.length; k++) {
        if (idxs[k] !== idxs[k - 1]! + 1) {
          contiguous = false
          break
        }
      }
      if (!contiguous) continue
      for (const i of idxs) used.add(i)
      const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim().slice(0, 24) : undefined
      const protagonists = Array.isArray(rec.protagonists)
        ? rec.protagonists
            .filter((n): n is string => typeof n === 'string' && !!nameKey(n))
            .map(n => nameKey(n))
            .filter(n => castPool.has(n) || [...castPool].some(c => c.includes(n) || n.includes(c)))
            .slice(0, 2)
        : undefined
      const nodes = Array.isArray(rec.nodes)
        ? rec.nodes
            .filter((n): n is string => typeof n === 'string' && !!n.trim())
            .map(n => n.trim().slice(0, 200))
            .slice(0, 12)
        : undefined
      out.push({ beats: idxs, ...(title ? { title } : {}), ...(protagonists?.length ? { protagonists } : {}), ...(nodes?.length ? { nodes } : {}) })
    }
  }
  // 兜底:未被有效分组覆盖的粗段 → 各自成段
  for (const i of beats.map(b => b.index)) {
    if (!used.has(i)) out.push({ beats: [i] })
  }
  // 按段首粗段排序,保证段序与正文一致
  out.sort((a, b) => a.beats[0]! - b.beats[0]!)
  return out
}

/** 标转折分块大小(每块粗段数;块内合并且只合并相邻,块间不合并) */
export const ANNOTATE_CHUNK_BEATS = 30

// ---- BookDoc 打包 ----

export interface BuildBookDocInput {
  title: string
  author?: string | null
  /** 归档全文(切段前原文;仅存档,不参与引用) */
  fulltext: string
  /** 粗段故事线(assembleStoryline 产物;startChar 用于按字符切正文) */
  storyline: StoryBeat[]
  /** 各粗段提取结果(与 storyline 对齐;status 为段角色文件「状态」的来源,§6.1) */
  extracts: (ChapterExtractStatuses | null)[]
  /** 成书 overlay:meta 入 manifest,characters 经代码翻译为中文保留键卡(§6.2) */
  overlay: WorldOverlay | null
  /** AI 标转折结果(缺省 = 一粗段一剧情段,无节点,v1 桥接行为) */
  annotations?: SegmentAnnotation[]
  /** 引擎派生数据随包(world.json,见 novel-v2.BookWorld) */
  world?: BookDoc['world']
  exportedAt?: string
}

/** 打包所需的单段角色数据(避免整包 ChapterExtraction 依赖;由调用方从提取结果取) */
export interface ChapterExtractStatuses {
  characters: { name: string, status?: string | null, plot?: string | null }[]
}

/** 把粗段按标注分组为剧情段;无标注时一粗段一段(导出供 finalize 弧线坐标换算复用) */
export function groupBeats(storyline: StoryBeat[], annotations: SegmentAnnotation[]): number[][] {
  const n = storyline.length
  if (n === 0) return []
  const valid = annotations.filter(a => a.beats.length > 0 && a.beats[0]! < n)
  if (!valid.length) return storyline.map((_, i) => [i])
  const groups: number[][] = []
  const used = new Set<number>()
  for (const a of valid) {
    const idxs = a.beats.filter(i => i < n && !used.has(i))
    if (!idxs.length) continue
    // 保持相邻:组内任一粗段与组首之间已用的粗段会被兜底插入,不影响段序
    for (const i of idxs) used.add(i)
    groups.push(idxs)
  }
  for (let i = 0; i < n; i++) {
    if (!used.has(i)) groups.push([i])
  }
  groups.sort((a, b) => a[0]! - b[0]!)
  return groups
}

/** 弧线坐标系统一(§11.1):粗段序 → 剧情段序。云端 arcs 按粗段细纲生成(与 annotate 并行),
 *  而游玩端/客户端 arcs 任务均以剧情段序消费(find(b.beatIndex === 当前段));落盘前在此换算,
 *  同一剧情段内的多条 beat 合并为一条(summary 以「;」拼接,status 取首条非空),保证每段至多一条。
 *  groups 为 groupBeats 产物(粗段 → 所在剧情段下标);空 groups(无粗段)时原样返回,降级安全。 */
export function remapArcsToSegments(arcs: CharacterArc[], groups: number[][]): CharacterArc[] {
  if (groups.length === 0) return arcs
  const segOf = new Map<number, number>()
  groups.forEach((beatIdxs, gi) => {
    for (const bi of beatIdxs) segOf.set(bi, gi)
  })
  return arcs.map((arc) => {
    const bySeg = new Map<number, { beatIndex: number, summary: string, status?: string | null }>()
    for (const beat of arc.beats) {
      const seg = segOf.get(beat.beatIndex)
      if (seg == null) continue // 越界/未知粗段:丢弃(归一化已保证升序合法,防御性兜底)
      const hit = bySeg.get(seg)
      if (hit) {
        if (beat.summary?.trim()) hit.summary = hit.summary ? `${hit.summary}；${beat.summary.trim()}` : beat.summary.trim()
        if (!hit.status && beat.status?.trim()) hit.status = beat.status.trim()
      } else {
        bySeg.set(seg, {
          beatIndex: seg,
          summary: beat.summary?.trim() ?? '',
          ...(beat.status?.trim() ? { status: beat.status.trim() } : {})
        })
      }
    }
    return { ...arc, beats: [...bySeg.values()].sort((a, b) => a.beatIndex - b.beatIndex) }
  })
}

/** 管线产物 → BookDoc(纯函数;AI 标转折结果决定剧情段粒度与节点) */
export function buildBookDoc(input: BuildBookDocInput): BookDoc {
  const { title, author, fulltext, storyline, extracts, overlay, annotations } = input
  const groups = groupBeats(storyline, annotations ?? [])

  const segments: BookDoc['segments'] = {}
  groups.forEach((beatIdxs, gi) => {
    const first = storyline[beatIdxs[0]!]!
    const lastIdx = beatIdxs[beatIdxs.length - 1]!
    const nextBeat = storyline[lastIdx + 1]
    // 正文切片:本段首粗段起点 → 下一段首粗段起点(粗段间有跳段/缺口时并入上一段,不丢字)
    const start = Math.max(0, first.startChar || 0)
    const end = nextBeat && typeof nextBeat.startChar === 'number' && nextBeat.startChar > start
      ? nextBeat.startChar
      : fulltext.length
    const annotation = annotations?.find(a => a.beats[0] === beatIdxs[0])
    const cast = [...new Set(beatIdxs.flatMap(i => storyline[i]?.cast ?? []))]
    const canon = {
      index: gi,
      ...(annotation?.title ? { title: annotation.title } : {}),
      cast,
      ...(annotation?.protagonists?.length ? { 主角: annotation.protagonists } : {}),
      beat: beatIdxs.map(i => storyline[i]?.summary ?? '').filter(Boolean).join(';'),
      ...(annotation?.nodes?.length
        ? { 节点: annotation.nodes.map((事件, n) => ({ n, 事件 })) as SegmentNode[] }
        : {}),
      ...(first.place ? { place: first.place } : {}),
      ...(first.turn ? { turn: first.turn } : {}),
      ...(first.hook ? { hook: first.hook } : {}),
      text: fulltext.slice(start, end)
    }
    // 段角色文件:仅建有本段可用内容(状态或剧情非空,空壳不落盘,§11.4)的角色;
    // 状态/剧情均取该段内最后一条非空提取值(§6.1:提取阶段直接产出每位 cast 的剧情+状态)
    const chars: Record<string, BookCharacter> = {}
    for (const name of cast) {
      let status: string | null = null
      let plot: string | null = null
      for (const bi of beatIdxs) {
        const hit = (extracts[bi]?.characters ?? []).find(c => nameKey(c.name) === nameKey(name))
        if (hit?.status && hit.status.trim()) status = hit.status.trim()
        if (hit?.plot && hit.plot.trim()) plot = hit.plot.trim()
      }
      if (!status && !plot) continue
      chars[name] = {
        姓名: name,
        ...(status ? { 状态: { 处境: status } } : {}),
        ...(plot ? { 剧情: plot } : {})
      }
    }
    segments[String(gi).padStart(3, '0')] = { canon, characters: chars }
  })

  // characters/:成书卡 → 中文保留键(代码翻译,非 AI 二次汇总);弧线唯一权威在 world.characterArcs(§11.1),不落「弧线」字段
  const characters: Record<string, BookCharacter> = {}
  for (const card of (overlay?.characters ?? []) as CharacterCard[]) {
    const bc = characterCardToBook(card)
    if (bc) characters[bc['姓名']] = bc
  }
  return {
    manifest: {
      format: BOOK2_FORMAT,
      version: BOOK2_VERSION,
      kind: 'book',
      title: overlay?.title?.trim() || title,
      ...(author ? { author } : {}),
      segmentCount: Object.keys(segments).length,
      charCount: Object.keys(characters).length,
      tags: overlay?.tags,
      orientation: overlay?.orientation,
      heat: overlay?.heat,
      setting: overlay?.setting,
      summary: overlay?.summary,
      ...(input.exportedAt ? { exportedAt: input.exportedAt } : {})
    },
    fulltext,
    segments,
    characters,
    ...(input.world ? { world: input.world } : {})
  }
}
