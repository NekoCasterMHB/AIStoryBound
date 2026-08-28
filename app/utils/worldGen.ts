// app/utils/worldGen.ts
// 浏览器端"上传 → 生成世界"编排(服务器只提供 /api/ai/chat 中继):
//   本地解析 → 作者识别 → 分块并发提取 → 本地合并 → 引用校验 → 一致性检查 → 成书 → 落 IndexedDB(works)
// 进度由本地状态驱动;中间产物仅内存(单章失败=跳过+告警,>1/3 失败中止)。
import { detectEncoding, extractFrontMatter, segmentChapters, uuid } from '#shared/novel'
import type {
  ChapterExtraction, ChapterSegment, CharacterCard, EntityConflict, LocalWork
} from '#shared/novel'
import {
  buildCheckMessages, buildEcoSynthMessages, buildExtractMessages, buildLocalCards,
  buildSynthesizeMessages, mergeExtractions, splitUnits, verifyQuotes,
  emptyExtraction, finalizeCards, normalizeExtraction, quoteByChapter,
  ADULT_GENRE, ECO_EXTRACT_MAX_TOKENS, ECO_SYNTH_MAX_TOKENS, TOP_CHARACTERS
} from '#shared/world-build'
import { aiChatJson, CancelledError } from './aiRelay'
import type { LiveTokenInfo } from './aiRelay'
import { detectAuthor } from './authorDetect'
import { loadGenLimits, DEFAULT_GEN_LIMITS } from './genSettings'
import type { GenLimits } from './genSettings'
import { extractCacheKey, loadExtractCache, saveExtractUnit, markExtractComplete } from './extractCache'
import { db } from './localDb'

const EXTRACT_CONCURRENCY = 4
/** 单章失败>总数该比例则中止整本生成 */
const MAX_FAIL_RATIO = 1 / 3

/** 无视限制(测试模式)的生成参数:每章一个提取单元(1M 字符上限=不切段)、输出上限取模型上限、超时放宽 */
const UNLIMITED_GEN_LIMITS: GenLimits = {
  ...DEFAULT_GEN_LIMITS,
  unitMaxChars: 1_000_000,
  unitOverlapChars: 0
}

/** 是否值得重试的瞬时错误:网络/解析异常、429 限流、5xx 上游错误;4xx 业务失败(如配额不足)重试无意义 */
function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number })?.status
  // 502 多为「AI 输出不是合法 JSON」:该次调用已生成输出并消耗 token,重试只会重复烧钱,直接记失败;
  // 其余瞬时错误(网络异常/429 限流/5xx 上游)重试一次仍值得
  return status === undefined || status === 429 || (status >= 500 && status !== 502)
}

/** AI 调用失败:附带 HTTP status 供重试判定(502 非 JSON 等已产生输出的失败自身带 usage,先入账再抛) */
function toAiError(res: { status: number, message: string }): Error & { status?: number } {
  const err = new Error(res.message) as Error & { status?: number }
  err.status = res.status
  return err
}

export interface GenerateProgress {
  stage: 'parse' | 'author' | 'extract' | 'merge' | 'check' | 'synthesize' | 'done'
  /** extract 阶段:已完成单元数 */
  doneUnits: number
  totalUnits: number
  /** 累计消耗 token(已完成调用的真实 usage) */
  tokensUsed: number
  /** 实时估算:已完成真实用量 + 流式进行中调用的估算合计(单调不减) */
  liveTokens: number
  warnings: string[]
}

export interface GenerateResult {
  work: LocalWork
  usage: { tokensUsed: number }
}

/** 一致性检查的 AI 输出结构(reviewed: 批注既有冲突;new_conflicts: 新发现冲突) */
interface CheckReview {
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

/** 并发池:fn 抛错则该项失败(由调用方决定跳过或中止);onDone 每项完成后回调(实时进度用)。
 *  signal 触发取消时:不再启动新任务,并抛 CancelledError 中止整个池 */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onDone?: (index: number) => void,
  signal?: AbortSignal
): Promise<(R | Error)[]> {
  const results: (R | Error)[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      if (signal?.aborted) throw new CancelledError()
      const item = items[i]
      if (item === undefined) return
      try {
        results[i] = await fn(item, i)
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
 * @param onProgress 各阶段进度回调(UI 用;liveTokens 单调不减)
 * @param opts.frontMatter 书名页/前言原文(作者识别用;上传流程由 parseLocalNovel 提供)
 * @param opts.knownAuthor 已知作者(预置小说有 meta.author 时直接采用,跳过识别)
 * @param opts.signal 取消信号:触发后中止在途 AI 调用,抛 CancelledError
 * @param opts.eco 节约模式:只提取 5 类核心实体、引用从简;跳过 AI 一致性检查;
 *                 成书只让 AI 出标题/简介/角色定位,人物卡由提取素材本地直拼(约省一半 token)
 * @param opts.limits 生成参数(单单元输入上限/切段重叠/提取、检查、成书输出上限/调用超时);缺省读个人中心配置的本地偏好
 * @param opts.unlimited 无视限制(测试模式):覆盖个人中心生成参数——每章一个提取单元(不切段)、
 *                      输出上限取模型上限、超时放宽;用于排查自定义参数导致的提取/成书失败,正式生成请关闭
 */
export async function generateWorld(
  title: string,
  chapters: ChapterSegment[],
  onProgress: (p: GenerateProgress) => void,
  opts: { frontMatter?: string, knownAuthor?: string, signal?: AbortSignal, eco?: boolean, limits?: GenLimits, unlimited?: boolean } = {}
): Promise<GenerateResult> {
  const warnings: string[] = []
  const { signal, eco = false } = opts
  const genLimits = opts.unlimited ? UNLIMITED_GEN_LIMITS : (opts.limits ?? loadGenLimits())
  /** 单次调用超时(秒→毫秒),随各阶段调用传给中继 */
  const relayTimeoutMs = genLimits.relayTimeoutSec * 1000
  const isAborted = () => signal?.aborted ?? false
  let tokensUsed = 0

  // ---- 1) Map:分块提取(并发 4,失败重试 1 次后跳过) ----
  const units = splitUnits(chapters, genLimits.unitMaxChars, genLimits.unitOverlapChars)

  /** 流式进行中调用的估算 token(按调用 key 登记,完成后删除并入真实用量) */
  const liveCalls = new Map<string, number>()
  /** 已展示的实时值下限:估算→真实回落时只增不减,保证 UI 数字单调 */
  let displayFloor = 0
  let lastLiveEmit = 0

  const progress = (stage: GenerateProgress['stage'], doneUnits = 0) => {
    displayFloor = Math.max(displayFloor, tokensUsed)
    onProgress({
      stage, doneUnits, totalUnits: units.length, tokensUsed,
      liveTokens: displayFloor, warnings: [...warnings]
    })
  }

  let completedUnits = 0
  /** 实时进度:单元完成时立即刷新;流式期间按节流刷新(实时 token 消耗,覆盖 author/extract/check/synthesize 全程) */
  const emitLive = (stage: GenerateProgress['stage'] = 'extract', live?: { tokens: number, speed: number }) => {
    const now = Date.now()
    if (live && now - lastLiveEmit < 200) return
    lastLiveEmit = now
    if (live) {
      // 并发流的估算合计,而非最后一次回调的单流值(避免数字来回跳)
      let est = 0
      for (const t of liveCalls.values()) est += t
      displayFloor = Math.max(displayFloor, tokensUsed + est)
    } else {
      displayFloor = Math.max(displayFloor, tokensUsed)
    }
    const unitDone = stage === 'extract' ? Math.min(completedUnits, units.length) : undefined
    onProgress({
      stage,
      doneUnits: unitDone ?? 0,
      totalUnits: units.length,
      tokensUsed,
      liveTokens: displayFloor,
      warnings: [...warnings]
    })
  }

  /** 为单次 AI 调用登记实时估算(调用完成后需 delete 该 key) */
  const liveHandler = (key: string, stage: GenerateProgress['stage']) => (info: LiveTokenInfo) => {
    liveCalls.set(key, info.tokens)
    emitLive(stage, info)
  }

  // ---- 0) 作者识别:正文(正则/AI)→ 未果按书名联网检索 ----
  let author: string | null = (opts.knownAuthor ?? '').trim() || null
  if (!author) {
    progress('author')
    const det = await detectAuthor(title, opts.frontMatter ?? '', chapters, liveHandler('author', 'author'), signal)
    if (isAborted()) throw new CancelledError()
    tokensUsed += det.tokensUsed
    liveCalls.delete('author')
    author = det.author
    if (det.searched && !author) {
      warnings.push('正文未识别到作者,联网检索未能确认,可在编辑页手动补充')
    }
  }
  progress('extract')

  // ---- 1) Map:分块提取(断点续跑:复用缓存中已完成单元,只重跑失败/缺失的,省 token) ----
  const cacheKey = await extractCacheKey(title, chapters, { eco, unitMaxChars: genLimits.unitMaxChars, unitOverlapChars: genLimits.unitOverlapChars })
  const cached = await loadExtractCache(cacheKey)
  const reused = new Map<number, ChapterExtraction>()
  if (cached) {
    for (let i = 0; i < units.length; i++) {
      const ex = cached.done[i]
      if (ex) reused.set(i, ex)
    }
    if (reused.size > 0) {
      warnings.push(`已复用上次提取的 ${reused.size}/${units.length} 个单元(0 token),仅重新提取剩余部分`)
    }
  }

  const extracts: (ChapterExtraction | null)[] = new Array(units.length).fill(null)
  for (const [i, ex] of reused) extracts[i] = ex
  const todoIndexes = units.map((_, i) => i).filter(i => !reused.has(i))
  /** 已完成单元数(含复用的):驱动 UI 进度,从复用数起步 */
  completedUnits = reused.size
  /** 成功单元数(含复用):失败率判定用 */
  let okCount = reused.size

  if (todoIndexes.length > 0) {
    const results = await pool(todoIndexes, EXTRACT_CONCURRENCY, async (unitIndex) => {
      const unit = units[unitIndex]!
      const attempt = async (): Promise<ChapterExtraction> => {
        const res = await aiChatJson<unknown>(buildExtractMessages(title, unit, eco), {
          // 输出上限取用户配置;节约模式再压到其自身上限(只会更小不会更大)
          maxTokens: eco ? Math.min(ECO_EXTRACT_MAX_TOKENS, genLimits.extractMaxTokens) : genLimits.extractMaxTokens,
          temperature: 0.2,
          thinking: false,
          timeoutMs: relayTimeoutMs
        }, {
          onLive: liveHandler(`u${unitIndex}`, 'extract'),
          signal
        })
        // 失败(如 502 非 JSON)也已产生输出,如实入账
        tokensUsed += res.usage?.totalTokens ?? 0
        if (!res.ok) throw toAiError(res)
        return normalizeExtraction(res.data)
      }
      try {
        return await attempt()
      } catch (e) {
        if (isAborted()) throw new CancelledError()
        // 4xx 业务失败(配额/鉴权)重试无意义,直接记为本单元失败
        if (!isRetryable(e)) throw e
        // 自动重试一次(退避 1.5s,应对上游瞬时限流/偶发非 JSON 输出)
        await sleep(1500)
        try {
          return await attempt()
        } catch (e2) {
          if (isAborted()) throw new CancelledError()
          return e2 as Error
        }
      }
    }, (unitIndex) => {
      completedUnits++
      liveCalls.delete(`u${unitIndex}`)
      emitLive()
    }, signal)
    if (isAborted()) throw new CancelledError()

    todoIndexes.forEach((unitIndex, j) => {
      const r = results[j]!
      if (r instanceof Error) {
        const label = units[unitIndex]?.label ?? `#${unitIndex + 1}`
        warnings.push(`单元「${label}」提取失败: ${r.message}`)
        // 失败原因输出到浏览器控制台,便于排查(仅前端可见,不进作品数据)
        console.warn(`[世界生成] 提取单元「${label}」失败:`, r)
      } else {
        okCount++
        extracts[unitIndex] = r
        // 增量写缓存:中断/失败后下次续跑只重跑缺失单元(失败单元不入缓存)
        void saveExtractUnit(cacheKey, unitIndex, r, { title, eco })
          .catch(() => { /* 缓存写入失败不影响主流程 */ })
      }
    })
  }
  if (units.length > 0 && okCount / units.length <= 1 - MAX_FAIL_RATIO) {
    throw new Error(`提取失败率过高(${units.length - okCount}/${units.length}),已中止。可重新生成续跑,已提取部分不会重复消耗 token。`)
  }
  // 全部单元成功 → 标记缓存完整(下次同书生成直接全量复用)
  if (okCount === units.length) {
    await markExtractComplete(cacheKey).catch(() => { /* 缓存写入失败不影响主流程 */ })
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

  // ---- 4) 一致性检查:批注既有冲突 + 发现新冲突(失败退避重试 1 次)。节约模式跳过,保留代码冲突检测 ----
  if (eco) {
    warnings.push('节约模式:已跳过 AI 一致性检查,仅保留代码检测到的设定冲突(可在编辑页人工复核)')
  } else if (entities.characters.length + entities.locations.length + entities.world_rules.length > 0) {
    const checkAttempt = async (): Promise<CheckReview> => {
      const res = await aiChatJson<CheckReview>(buildCheckMessages(title, entities, conflicts), {
        maxTokens: genLimits.checkMaxTokens,
        temperature: 0.2,
        thinking: false,
        timeoutMs: relayTimeoutMs
      }, {
        onLive: liveHandler('check', 'check'),
        signal
      })
      if (isAborted()) throw new CancelledError()
      tokensUsed += res.usage?.totalTokens ?? 0
      if (!res.ok) throw toAiError(res)
      return res.data
    }
    let checkData: CheckReview | null = null
    try {
      checkData = await checkAttempt()
    } catch (e) {
      if (isAborted()) throw new CancelledError()
      // 4xx 业务失败(配额/鉴权)重试无意义,直接按检查失败降级
      if (!isRetryable(e)) {
        warnings.push(`一致性检查失败: ${(e as Error).message}`)
      } else {
        // 自动重试一次(退避 1.5s,应对上游瞬时限流/偶发非 JSON 输出)
        await sleep(1500)
        try {
          checkData = await checkAttempt()
        } catch (e2) {
          if (isAborted()) throw new CancelledError()
          warnings.push(`一致性检查失败: ${(e2 as Error).message}`)
        }
      }
    }
    liveCalls.delete('check')
    if (checkData) {
      const byId = new Map(conflicts.map(c => [c.id, c]))
      for (const r of checkData.reviewed ?? []) {
        const c = r.conflict_id ? byId.get(r.conflict_id) : undefined
        if (c && r.verdict) {
          c.verdict = r.verdict as EntityConflict['verdict']
          c.reason = r.reason ?? null
        }
      }
      for (const n of checkData.new_conflicts ?? []) {
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
    }
  }
  progress('synthesize')

  // ---- 5) 成书 ----
  // 完整模式:前 TOP_CHARACTERS 的完整人物卡 + 题材/简介(失败退避重试 1 次);
  // 节约模式:AI 只出标题/简介/角色定位(失败不中止,人物卡直接由实体素材本地拼出)。
  let overlay: { title: string, genre?: string, summary?: string, characters: CharacterCard[] }
  if (eco) {
    const synthAttempt = async (): Promise<{ title?: string, summary?: string, roles?: { name?: string, role?: string }[] }> => {
      const res = await aiChatJson<{
        title?: string
        summary?: string
        roles?: { name?: string, role?: string }[]
      }>(buildEcoSynthMessages(title, entities), {
        maxTokens: ECO_SYNTH_MAX_TOKENS,
        temperature: 0.3,
        thinking: false,
        timeoutMs: relayTimeoutMs
      }, {
        onLive: liveHandler('synth', 'synthesize'),
        signal
      })
      if (isAborted()) throw new CancelledError()
      tokensUsed += res.usage?.totalTokens ?? 0
      if (!res.ok) throw toAiError(res)
      return res.data ?? {}
    }
    let ecoSynth: { title?: string, summary?: string, roles?: { name?: string, role?: string }[] } | null = null
    try {
      ecoSynth = await synthAttempt()
    } catch (e) {
      if (isAborted()) throw new CancelledError()
      // 4xx 业务失败(配额/鉴权)重试无意义,直接按降级处理
      if (!isRetryable(e)) {
        warnings.push(`节约模式:成书概览生成失败(${(e as Error).message}),人物卡已按提取素材直接生成`)
      } else {
        await sleep(1500)
        try {
          ecoSynth = await synthAttempt()
        } catch (e2) {
          if (isAborted()) throw new CancelledError()
          warnings.push(`节约模式:成书概览生成失败(${(e2 as Error).message}),人物卡已按提取素材直接生成`)
        }
      }
    }
    liveCalls.delete('synth')
    overlay = {
      title: ecoSynth?.title?.trim() || title,
      genre: ADULT_GENRE,
      summary: ecoSynth?.summary?.trim() || undefined,
      characters: buildLocalCards(entities, ecoSynth?.roles)
    }
  } else {
    const topNames = new Set(
      [...entities.characters].sort((a, b) => b.mentionCount - a.mentionCount)
        .slice(0, TOP_CHARACTERS)
        .map(c => c.name)
    )
    const synthAttempt = async (): Promise<{ title?: string, summary?: string, characters?: CharacterCard[] }> => {
      const res = await aiChatJson<{
        title?: string
        summary?: string
        characters?: CharacterCard[]
      }>(buildSynthesizeMessages(title, entities, conflicts, warnings), {
        maxTokens: genLimits.synthMaxTokens,
        temperature: 0.3,
        thinking: false,
        timeoutMs: relayTimeoutMs
      }, {
        onLive: liveHandler('synth', 'synthesize'),
        signal
      })
      if (isAborted()) throw new CancelledError()
      tokensUsed += res.usage?.totalTokens ?? 0
      if (!res.ok) throw toAiError(res)
      return res.data ?? {}
    }
    let synthData: { title?: string, summary?: string, characters?: CharacterCard[] }
    try {
      synthData = await synthAttempt()
    } catch (e) {
      if (isAborted()) throw new CancelledError()
      // 4xx 业务失败(配额/鉴权)重试无意义;其余瞬时错误退避重试一次
      if (!isRetryable(e)) throw new Error(`成书失败: ${(e as Error).message}`, { cause: e })
      // 自动重试一次(退避 1.5s,应对上游瞬时限流/偶发非 JSON 输出)
      await sleep(1500)
      try {
        synthData = await synthAttempt()
      } catch (e2) {
        if (isAborted()) throw new CancelledError()
        throw new Error(`成书失败: ${(e2 as Error).message}`, { cause: e2 })
      }
    }
    liveCalls.delete('synth')
    const overlayRaw = synthData

    // 后处理:只保留实体库中的角色;first_appearance 缺失时按出现章节兜底(shared 实现,与预生成脚本共用)
    const characters = finalizeCards(overlayRaw, entities, topNames)

    overlay = {
      title: overlayRaw.title || title,
      genre: ADULT_GENRE,
      summary: overlayRaw.summary || undefined,
      characters
    }
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
