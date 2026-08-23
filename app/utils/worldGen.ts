// app/utils/worldGen.ts
// 浏览器端"上传 → 生成世界"编排(服务器只提供 /api/ai/chat 中继):
//   本地解析 → 作者识别 → 分块并发提取 → 本地合并 → 引用校验 → 一致性检查 → 成书 → 落 IndexedDB(works)
// 进度由本地状态驱动;中间产物仅内存(单章失败=跳过+告警,>1/3 失败中止)。
import { detectEncoding, extractFrontMatter, segmentChapters, uuid } from '../../shared/novel'
import type {
  ChapterExtraction, ChapterSegment, CharacterCard, EntityConflict, EntitySource, LocalWork, WorldEntities
} from '../../shared/novel'
import {
  buildCheckMessages, buildExtractMessages, buildSynthesizeMessages, mergeExtractions,
  splitUnits, verifyQuotes, TOP_CHARACTERS
} from '../../shared/world-build'
import { aiChatJson } from './aiRelay'
import { detectAuthor } from './authorDetect'
import { db } from './localDb'

const EXTRACT_CONCURRENCY = 4
/** 单章失败>总数该比例则中止整本生成 */
const MAX_FAIL_RATIO = 1 / 3

export interface GenerateProgress {
  stage: 'parse' | 'author' | 'extract' | 'merge' | 'check' | 'synthesize' | 'done'
  /** extract 阶段:已完成单元数 */
  doneUnits: number
  totalUnits: number
  /** 累计消耗 token(已完成调用的真实 usage) */
  tokensUsed: number
  /** 实时估算:已完成真实用量 + 当前流估算(未完成调用),仅供 UI 实时展示 */
  liveTokens?: number
  /** tokens/秒(当前流估算) */
  liveSpeed?: number
  warnings: string[]
}

export interface GenerateResult {
  work: LocalWork
  usage: { tokensUsed: number }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 本地解析 TXT 文件:编码检测 + 清洗 + 章节切分(与预置预览同一套 shared 纯函数) */
export async function parseLocalNovel(file: File): Promise<{ title: string, encoding: string, chapters: ChapterSegment[], frontMatter: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const encoding = detectEncoding(bytes)
  const text = new TextDecoder(encoding).decode(bytes)
  return {
    title: file.name.replace(/\.(txt|text)$/i, '') || '未命名小说',
    encoding,
    // 书名页/前言原文(作者识别用;stripFrontHeader 会把其中的书名/作者行从正文剥除)
    frontMatter: extractFrontMatter(text),
    chapters: parseChaptersFromText(text)
  }
}

/** 从整本文本切分出章节(预置页等已有文本的场景用) */
export function parseChaptersFromText(text: string): ChapterSegment[] {
  const cleaned = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n')
  const chapters = segmentChapters(cleaned)
  if (chapters.length === 0) {
    throw new Error('文本为空或无法解析为章节')
  }
  return chapters
}

/** 校验提取输出的结构,返回数组字段齐全的规范化结果 */
function normalizeExtraction(raw: unknown): ChapterExtraction {
  const r = (raw ?? {}) as Partial<ChapterExtraction>
  return {
    characters: Array.isArray(r.characters) ? r.characters : [],
    locations: Array.isArray(r.locations) ? r.locations : [],
    factions: Array.isArray(r.factions) ? r.factions : [],
    timeline_events: Array.isArray(r.timeline_events) ? r.timeline_events : [],
    world_rules: Array.isArray(r.world_rules) ? r.world_rules : [],
    items: Array.isArray(r.items) ? r.items : [],
    foreshadowing: Array.isArray(r.foreshadowing) ? r.foreshadowing : []
  }
}

/** 并发池:fn 抛错则该项失败(由调用方决定跳过或中止);onDone 每项完成后回调(实时进度用) */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onDone?: (index: number) => void
): Promise<(R | Error)[]> {
  const results: (R | Error)[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      const item = items[i]
      if (item === undefined) return
      try {
        results[i] = await fn(item)
      } catch (e) {
        results[i] = e as Error
      }
      onDone?.(i)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 全流程生成:作者识别 → 提取 → 合并 → 引用校验 → 检查 → 成书。
 * @param onProgress 各阶段进度回调(UI 用)
 * @param opts.frontMatter 书名页/前言原文(作者识别用;上传流程由 parseLocalNovel 提供)
 * @param opts.knownAuthor 已知作者(预置小说有 meta.author 时直接采用,跳过识别)
 */
export async function generateWorld(
  title: string,
  chapters: ChapterSegment[],
  onProgress: (p: GenerateProgress) => void,
  opts: { frontMatter?: string, knownAuthor?: string } = {}
): Promise<GenerateResult> {
  const warnings: string[] = []
  let tokensUsed = 0

  // ---- 1) Map:分块提取(并发 4,失败重试 1 次后跳过) ----
  const units = splitUnits(chapters)
  const progress = (stage: GenerateProgress['stage'], doneUnits = 0) => {
    onProgress({
      stage, doneUnits, totalUnits: units.length, tokensUsed, warnings: [...warnings]
    })
  }

  const extracts: (ChapterExtraction | null)[] = []
  let completedUnits = 0
  let lastLiveEmit = 0
  /** 实时进度:单元完成时立即刷新;流式期间按节流刷新(实时 token 消耗,覆盖 author/extract/check/synthesize 全程) */
  const emitLive = (stage: GenerateProgress['stage'] = 'extract', live?: { tokens: number, speed: number }) => {
    const now = Date.now()
    if (live && now - lastLiveEmit < 200) return
    lastLiveEmit = now
    const unitDone = stage === 'extract' ? Math.min(completedUnits, units.length) : undefined
    onProgress({
      stage,
      doneUnits: unitDone ?? 0,
      totalUnits: units.length,
      tokensUsed,
      liveTokens: live ? tokensUsed + live.tokens : undefined,
      liveSpeed: live?.speed,
      warnings: [...warnings]
    })
  }

  // ---- 0) 作者识别:正文(正则/AI)→ 未果按书名联网检索 ----
  let author: string | null = (opts.knownAuthor ?? '').trim() || null
  if (!author) {
    progress('author')
    const det = await detectAuthor(title, opts.frontMatter ?? '', chapters, (info) => emitLive('author', info))
    tokensUsed += det.tokensUsed
    author = det.author
    if (det.searched && !author) {
      warnings.push('正文未识别到作者,联网检索未能确认,可在编辑页手动补充')
    }
  }
  progress('extract')

  const results = await pool(units, EXTRACT_CONCURRENCY, async (unit) => {
    const attempt = async (): Promise<ChapterExtraction> => {
      const res = await aiChatJson<unknown>(buildExtractMessages(title, unit), {
        maxTokens: 6000,
        temperature: 0.2,
        thinking: false
      }, {
        onLive: info => emitLive('extract', info)
      })
      if (!res.ok) throw new Error(res.message)
      tokensUsed += res.usage?.totalTokens ?? 0
      return normalizeExtraction(res.data)
    }
    try {
      return await attempt()
    } catch {
      // 自动重试一次(退避 1.5s,应对上游瞬时限流)
      await sleep(1500)
      try {
        return await attempt()
      } catch (e2) {
        return e2 as Error
      }
    }
  }, () => {
    completedUnits++
    emitLive()
  })

  let okCount = 0
  results.forEach((r, i) => {
    const unit = units[i]
    if (r instanceof Error) {
      warnings.push(`单元「${unit?.label ?? `#${i + 1}`}」提取失败: ${r.message}`)
      extracts.push(null)
    } else {
      okCount++
      extracts.push(r)
    }
  })
  if (units.length > 0 && okCount / units.length <= 1 - MAX_FAIL_RATIO) {
    throw new Error(`提取失败率过高(${units.length - okCount}/${units.length}),已中止。请重试或检查 AI 配置。`)
  }
  progress('merge')

  // ---- 2) Reduce:本地合并 + 3) 引用校验 ----
  const { entities, conflicts } = mergeExtractions(
    extracts.map((ex, i) => ({ chapter: units[i]?.chapter ?? 0, extract: ex ?? emptyExtraction() }))
  )
  const { unverified } = verifyQuotes(entities, chapters)
  if (unverified > 0) {
    warnings.push(`${unverified} 条原文引用未通过逐字校验(记录已保留,可人工复核)`)
  }

  // ---- 4) 一致性检查:批注既有冲突 + 发现新冲突 ----
  if (entities.characters.length + entities.locations.length + entities.world_rules.length > 0) {
    const checkRes = await aiChatJson<{
      reviewed?: { conflict_id?: string, verdict?: string, reason?: string }[]
      new_conflicts?: {
        entity_type?: string
        entity_name?: string
        field?: string
        evidence_a?: { chapter?: number }
        evidence_b?: { chapter?: number }
        verdict?: string
        reason?: string
      }[]
    }>(buildCheckMessages(title, entities, conflicts), {
      maxTokens: 4000,
      temperature: 0.2,
      thinking: false
    }, {
      onLive: info => emitLive('check', info)
    })
    if (checkRes.ok && checkRes.data) {
      tokensUsed += checkRes.usage?.totalTokens ?? 0
      const d = checkRes.data
      const byId = new Map(conflicts.map(c => [c.id, c]))
      for (const r of d.reviewed ?? []) {
        const c = r.conflict_id ? byId.get(r.conflict_id) : undefined
        if (c && r.verdict) {
          c.verdict = r.verdict as EntityConflict['verdict']
          c.reason = r.reason ?? null
        }
      }
      for (const n of d.new_conflicts ?? []) {
        if (!n.entity_type || !n.entity_name || !n.field) continue
        conflicts.push({
          id: uuid(),
          entityType: n.entity_type,
          entityName: n.entity_name,
          field: n.field,
          evidenceA: quoteByChapter(entities, n.evidence_a?.chapter),
          evidenceB: quoteByChapter(entities, n.evidence_b?.chapter),
          verdict: n.verdict as EntityConflict['verdict'],
          reason: n.reason ?? null,
          source: 'ai_check'
        })
      }
    } else if (!checkRes.ok) {
      warnings.push(`一致性检查失败: ${(checkRes as { message: string }).message}`)
    }
  }
  progress('synthesize')

  // ---- 5) 成书:前 TOP_CHARACTERS 的完整人物卡 + 题材/简介 ----
  const topNames = new Set(
    [...entities.characters].sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, TOP_CHARACTERS)
      .map(c => c.name)
  )
  const synthRes = await aiChatJson<{
    title?: string
    summary?: string
    characters?: CharacterCard[]
  }>(buildSynthesizeMessages(title, entities, conflicts, warnings), {
    maxTokens: 16000,
    temperature: 0.3,
    thinking: false
  }, {
    onLive: info => emitLive('synthesize', info)
  })
  if (!synthRes.ok) {
    throw new Error(`成书失败: ${synthRes.message}`)
  }
  tokensUsed += synthRes.usage?.totalTokens ?? 0
  const overlayRaw = synthRes.data ?? {}

  // 后处理:只保留实体库中的角色;first_appearance 缺失时按出现章节兜底
  const nameToEntity = new Map(entities.characters.map(c => [normKey(c.name), c]))
  const characters = (Array.isArray(overlayRaw.characters) ? overlayRaw.characters : [])
    .filter(c => c?.name && topNames.has(c.name))
    .map((c) => {
      const ent = nameToEntity.get(normKey(c.name))
      if (!c.first_appearance && ent && ent.sources.length > 0) {
        const ch = Math.min(...ent.sources.map(s => s.chapter))
        return { ...c, first_appearance: `第${ch}章` }
      }
      return c
    })

  const overlay = {
    title: overlayRaw.title || title,
    summary: overlayRaw.summary || undefined,
    characters
  }

  progress('done', units.length)

  const now = new Date().toISOString()
  const work: LocalWork = {
    id: uuid(),
    title: overlay.title || title,
    author: author ?? undefined,
    createdAt: now,
    updatedAt: now,
    chapters,
    syncStatus: 'local',
    tokensUsed,
    entities,
    conflicts,
    warnings,
    overlay
  }
  await saveWork(work)
  return { work, usage: { tokensUsed } }
}

function emptyExtraction(): ChapterExtraction {
  return { characters: [], locations: [], factions: [], timeline_events: [], world_rules: [], items: [], foreshadowing: [] }
}

function normKey(s: string): string {
  return (s ?? '').replace(/\s+/g, '').trim()
}

/** 按章节号从实体库回填引用文本(AI 检查只回章节号,引用以实体 sources 为准) */
function quoteByChapter(entities: WorldEntities, chapter?: number): EntitySource | null {
  if (!chapter) return null
  for (const list of [
    entities.characters, entities.locations, entities.factions, entities.timeline_events,
    entities.world_rules, entities.items, entities.foreshadowing
  ]) {
    for (const e of list) {
      const s = e.sources.find(s => s.chapter === chapter)
      if (s) return s
    }
  }
  return { chapter }
}

// ---- 本地作品库(IndexedDB works) ----

const STORE_WORKS = 'works'

export async function listWorks(): Promise<LocalWork[]> {
  if (typeof indexedDB === 'undefined') return []
  const d = await db()
  // 按最后操作时间倒序(无 updatedAt 的旧数据回退创建时间)
  return (await d.getAll(STORE_WORKS)).sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
  )
}

export async function getWork(id: string): Promise<LocalWork | null> {
  if (typeof indexedDB === 'undefined') return null
  const d = await db()
  return (await d.get(STORE_WORKS, id)) ?? null
}

export async function saveWork(work: LocalWork): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.put(STORE_WORKS, JSON.parse(JSON.stringify(work)))
}

export async function deleteWork(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.delete(STORE_WORKS, id)
}

/** 记录一次浏览/操作:刷新最后操作时间(书架卡片展示用;无作品时静默) */
export async function touchWork(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const work = await getWork(id)
  if (!work) return
  work.updatedAt = new Date().toISOString()
  await saveWork(work)
}

/** 游玩消耗追加到作品累计 tokens(书架卡片展示用),同时刷新最后操作时间 */
export async function addWorkTokens(id: string, tokens: number): Promise<void> {
  if (typeof indexedDB === 'undefined' || !tokens || tokens <= 0) return
  const work = await getWork(id)
  if (!work) return
  work.tokensUsed = (work.tokensUsed ?? 0) + tokens
  work.updatedAt = new Date().toISOString()
  await saveWork(work)
}
