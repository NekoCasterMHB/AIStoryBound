// app/utils/worldGen.ts
// 浏览器端"上传 → 生成世界"编排(服务器只提供 /api/ai/chat 中继):
//   本地解析 → 作者识别 → 分块并发提取 → 本地合并 → 引用校验 → 一致性检查 → 成书 → 落 IndexedDB(works)
// 进度由本地状态驱动;中间产物仅内存(单章失败=跳过+告警,>1/3 失败中止)。
import { extractFrontMatter, uuid } from '#shared/novel'
import { detectNovelEncoding } from '#shared/novel-encoding'
import type {
  ChapterExtraction, ChapterSegment, EntityConflict, LocalWork, WorldOverlay
} from '#shared/novel'
import {
  assembleStoryline, buildCheckMessages, buildEcoSynthMessages, buildExtractMessages, buildLocalCards,
  buildSynthesizeMessages, mergeExtractions, mergeOverlayMeta, splitUnits, summarizeWorldLocal, verifyQuotes,
  emptyExtraction, finalizeCards, normalizeExtraction, normKey, quoteByChapter,
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

/** 输出/超时走平台默认,不受个人中心自定义值影响;分段仍读用户配置 */
function resolveGenLimits(limits?: GenLimits): GenLimits {
  const user = limits ?? loadGenLimits()
  return {
    ...DEFAULT_GEN_LIMITS,
    unitMaxChars: user.unitMaxChars,
    unitOverlapChars: user.unitOverlapChars
  }
}

/**
 * 平台默认 384K 表示「不限制」:不要发给上游 max_tokens(DeepSeek 等常见上限 8K,传 384K 会 400,进度卡在提取 15%)。
 * 节约模式的精简上限仍传入。
 */
function outputCap(n: number | undefined, ecoCap?: number): number | undefined {
  if (ecoCap != null) return ecoCap
  if (n == null || n >= 100_000) return undefined
  return n
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
  /** 调试:当前在跑的提取单元标签 */
  debugHint?: string
  /** 调试:进行中的并发调用数 */
  inflight?: number
  /** 调试:单次提取输入上限(字符) */
  unitMaxChars?: number
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

/** 给可能挂死的异步(缓存读等)设超时,超时返回 fallback */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 本地解析 TXT 文件:编码检测 + 清洗 + 单段全文(不再按章节切分) */
export async function parseLocalNovel(file: File): Promise<{ title: string, encoding: string, chapters: ChapterSegment[], frontMatter: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // 检测编码并直接取解码结果(返回值可能来自二重乱码修复通道,不是合法的 TextDecoder 标签)
  const detected = detectNovelEncoding(bytes)
  return {
    title: file.name.replace(/\.(txt|text)$/i, '') || '未命名小说',
    encoding: detected.encoding,
    // 书名页/前言原文(作者识别用)
    frontMatter: extractFrontMatter(detected.text),
    chapters: toContentSegments(detected.text)
  }
}

/** 整本文本规范化为单个正文段(本地作品/预置书统一存单段全文,提取按字数分块,不依赖章节结构) */
export function toContentSegments(text: string): ChapterSegment[] {
  const cleaned = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!cleaned) {
    throw new Error('文本为空或无法解析')
  }
  return [{ title: '', content: cleaned }]
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
 * @param opts.limits 生成参数;实际只采用单单元输入上限与切段重叠,输出上限/超时一律走平台默认
 */
export async function generateWorld(
  title: string,
  chapters: ChapterSegment[],
  onProgress: (p: GenerateProgress) => void,
  opts: { frontMatter?: string, knownAuthor?: string, signal?: AbortSignal, eco?: boolean, limits?: GenLimits } = {}
): Promise<GenerateResult> {
  const warnings: string[] = []
  const { signal, eco = false } = opts
  const genLimits = resolveGenLimits(opts.limits)
  /** 单次调用超时(秒→毫秒),随各阶段调用传给中继 */
  const relayTimeoutMs = genLimits.relayTimeoutSec * 1000
  const isAborted = () => signal?.aborted ?? false
  let tokensUsed = 0
  const trace = (msg: string) => console.debug(`[世界生成] ${Date.now()} ${msg}`)

  // ---- 1) Map:分块提取(并发 4,失败重试 1 次后跳过) ----
  const units = splitUnits(chapters, genLimits.unitMaxChars, genLimits.unitOverlapChars)
  trace(`切段完成: ${units.length} 个单元,全书 ${chapters.reduce((s, c) => s + c.content.length, 0)} 字`)

  /** 流式进行中调用的估算 token(按调用 key 登记,完成后删除并入真实用量) */
  const liveCalls = new Map<string, number>()
  /** 已展示的实时值下限:估算→真实回落时只增不减,保证 UI 数字单调 */
  let displayFloor = 0
  let lastLiveEmit = 0

  const snapshot = (stage: GenerateProgress['stage'], extra?: Partial<GenerateProgress>): GenerateProgress => ({
    stage,
    doneUnits: extra?.doneUnits ?? (stage === 'extract' ? Math.min(completedUnits, units.length) : 0),
    totalUnits: units.length,
    tokensUsed,
    liveTokens: displayFloor,
    warnings: [...warnings],
    inflight: liveCalls.size,
    unitMaxChars: genLimits.unitMaxChars,
    debugHint: extra?.debugHint
  })

  const progress = (stage: GenerateProgress['stage'], doneUnits = 0, debugHint?: string) => {
    displayFloor = Math.max(displayFloor, tokensUsed)
    onProgress(snapshot(stage, { doneUnits, debugHint }))
  }

  let completedUnits = 0
  /** 实时进度:单元完成时立即刷新;流式期间按节流刷新(实时 token 消耗,覆盖 author/extract/check/synthesize 全程) */
  const emitLive = (stage: GenerateProgress['stage'] = 'extract', live?: LiveTokenInfo) => {
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
    const waited = live ? Math.round(live.elapsedMs / 1000) : 0
    onProgress(snapshot(stage, {
      debugHint: stage === 'extract'
        ? `进行中 ${liveCalls.size} 路${waited ? ` · 已等待 ${waited}s` : ''}${live && live.tokens ? ` · 流估算 ${live.tokens}` : ''}`
        : undefined
    }))
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
  progress('extract', 0, `切段 ${units.length} 个单元,上限 ${genLimits.unitMaxChars} 字,正在计算缓存 key…`)

  // ---- 1) Map:分块提取(断点续跑:复用缓存中已完成单元,只重跑失败/缺失的,省 token) ----
  // 缓存只是优化,读取失败/超时一律跳过复用直接提取,绝不让缓存拖住生成。
  let cached: Awaited<ReturnType<typeof loadExtractCache>> = null
  let cacheKey = ''
  try {
    trace('计算缓存 key…')
    cacheKey = await withTimeout(extractCacheKey(title, chapters, {
      eco, unitMaxChars: genLimits.unitMaxChars, unitOverlapChars: genLimits.unitOverlapChars
    }), 8000, '')
    trace(`缓存 key 就绪: ${cacheKey.slice(0, 12)}…`)
    progress('extract', 0, `缓存 key 已就绪,准备提取`)
    if (cacheKey) cached = await withTimeout(loadExtractCache(cacheKey), 3000, null)
  } catch (e) {
    warnings.push(`提取缓存不可用(${(e as Error)?.message ?? e}),已跳过复用直接提取`)
    progress('extract', 0, `缓存不可用,直接提取`)
  }
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
    // 过程日志只走 trace 打点,不写入 warnings(warnings 会持久化到作品,只留真实告警)
    progress('extract', completedUnits, `待提取 ${todoIndexes.length} 个单元`)
    trace(`开始并发提取 ${todoIndexes.length} 个单元(并发 ${EXTRACT_CONCURRENCY})`)
    const results = await pool(todoIndexes, EXTRACT_CONCURRENCY, async (unitIndex) => {
      const unit = units[unitIndex]!
      const attempt = async (): Promise<ChapterExtraction> => {
        const cap = outputCap(genLimits.extractMaxTokens, eco ? ECO_EXTRACT_MAX_TOKENS : undefined)
        emitLive('extract')
        trace(`请求发出: 单元「${unit.label}」(${unit.content.length} 字${cap ? `,maxTokens=${cap}` : ',不传 max_tokens'})`)
        const res = await aiChatJson<unknown>(buildExtractMessages(title, unit, eco), {
          maxTokens: cap,
          temperature: 0.2,
          timeoutMs: relayTimeoutMs,
          purpose: 'worldGen'
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
        const msg = e instanceof Error ? e.message : String(e)
        const status = (e as { status?: number })?.status
        warnings.push(`单元「${unit.label}」失败${status ? `(HTTP ${status})` : ''}: ${msg}`)
        emitLive('extract')
        // 4xx 业务失败(配额/鉴权)重试无意义,直接记为本单元失败
        if (!isRetryable(e)) throw e
        // 自动重试一次(退避 1.5s,应对上游瞬时限流/偶发非 JSON 输出)
        await sleep(1500)
        try {
          return await attempt()
        } catch (e2) {
          if (isAborted()) throw new CancelledError()
          const msg2 = e2 instanceof Error ? e2.message : String(e2)
          const status2 = (e2 as { status?: number })?.status
          warnings.push(`单元「${unit.label}」重试仍失败${status2 ? `(HTTP ${status2})` : ''}: ${msg2}`)
          emitLive('extract')
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
        console.warn(`[世界生成] 提取单元「${label}」失败:`, r)
      } else {
        okCount++
        extracts[unitIndex] = r
        // 增量写缓存:中断/失败后下次续跑只重跑缺失单元(失败单元不入缓存)
        // cacheKey 为空(计算超时/失败)时跳过,避免多个作品共用空 key 互相污染
        if (cacheKey) {
          void saveExtractUnit(cacheKey, unitIndex, r, { title, eco })
            .catch(() => { /* 缓存写入失败不影响主流程 */ })
        }
      }
    })
  }
  if (units.length > 0 && okCount / units.length <= 1 - MAX_FAIL_RATIO) {
    throw new Error(`提取失败率过高(${units.length - okCount}/${units.length}),已中止。可重新生成续跑,已提取部分不会重复消耗 token。`)
  }
  // 全部单元成功 → 标记缓存完整(下次同书生成直接全量复用);cacheKey 为空时跳过
  if (cacheKey && okCount === units.length) {
    await markExtractComplete(cacheKey).catch(() => { /* 缓存写入失败不影响主流程 */ })
  }
  progress('merge')

  // ---- 2) Reduce:本地合并 + 3) 引用校验(按段快照为角色生成阶段变体) ----
  const { entities, conflicts } = mergeExtractions(
    extracts.map((ex, i) => ({ chapter: units[i]?.chapter ?? 0, extract: ex ?? emptyExtraction(), startChar: units[i]?.startChar }))
  )
  const { unverified } = verifyQuotes(entities, units.map(u => ({ title: u.label, content: u.content })))
  if (unverified > 0) {
    warnings.push(`${unverified} 条原文引用未通过逐字校验(记录已保留,可人工复核)`)
  }
  const { storyline, gaps } = assembleStoryline(units, extracts)
  if (gaps.length > 0) {
    warnings.push(`${gaps.length} 个提取单元缺少情节细纲(失败或模型未输出),故事线已跳过这些段,未编造`)
  }
  const localSummary = summarizeWorldLocal(entities, storyline)

  // ---- 4) 一致性检查:批注既有冲突 + 发现新冲突(失败退避重试 1 次)。节约模式跳过,保留代码冲突检测 ----
  if (eco) {
    warnings.push('节约模式:已跳过 AI 一致性检查,仅保留代码检测到的设定冲突(可在编辑页人工复核)')
  } else if (entities.characters.length + entities.locations.length + entities.world_rules.length > 0) {
    const checkAttempt = async (): Promise<CheckReview> => {
      const res = await aiChatJson<CheckReview>(buildCheckMessages(title, entities, conflicts), {
        maxTokens: outputCap(genLimits.checkMaxTokens),
        temperature: 0.2,
        timeoutMs: relayTimeoutMs,
        purpose: 'worldGen'
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
  let overlay: WorldOverlay
  if (eco) {
    const synthAttempt = async (): Promise<WorldOverlay & { roles?: { name?: string, role?: string }[] }> => {
      const res = await aiChatJson<WorldOverlay & { roles?: { name?: string, role?: string }[] }>(buildEcoSynthMessages(title, entities, localSummary), {
        maxTokens: ECO_SYNTH_MAX_TOKENS,
        temperature: 0.3,
        timeoutMs: relayTimeoutMs,
        purpose: 'worldGen'
      }, {
        onLive: liveHandler('synth', 'synthesize'),
        signal
      })
      if (isAborted()) throw new CancelledError()
      tokensUsed += res.usage?.totalTokens ?? 0
      if (!res.ok) throw toAiError(res)
      return res.data ?? {}
    }
    let ecoSynth: (WorldOverlay & { roles?: { name?: string, role?: string }[] }) | null = null
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
      characters: buildLocalCards(entities, ecoSynth?.roles),
      ...mergeOverlayMeta(ecoSynth, localSummary)
    }
  } else {
    const topNames = new Set(
      [...entities.characters].sort((a, b) => b.mentionCount - a.mentionCount)
        .slice(0, TOP_CHARACTERS)
        .map(c => c.name)
    )
    const synthAttempt = async (): Promise<WorldOverlay> => {
      const res = await aiChatJson<WorldOverlay>(buildSynthesizeMessages(title, entities, conflicts, warnings, localSummary), {
        maxTokens: outputCap(genLimits.synthMaxTokens),
        temperature: 0.3,
        timeoutMs: relayTimeoutMs,
        purpose: 'worldGen'
      }, {
        onLive: liveHandler('synth', 'synthesize'),
        signal
      })
      if (isAborted()) throw new CancelledError()
      tokensUsed += res.usage?.totalTokens ?? 0
      if (!res.ok) throw toAiError(res)
      return res.data ?? {}
    }
    /** 成书完整性校验:top 名单中模型漏产的角色卡。输出被上游 max_tokens 截断时,
     *  extractJson 会把截断 JSON 静默修复成"只剩排在前面的几张卡"的合法结果(主角排第一,配角全丢),
     *  解析层无法感知,只能在这里按数量兜底。名字按 normKey 对齐,容忍空白差异。 */
    const missingCards = (data: WorldOverlay): string[] => {
      const returned = new Set((data.characters ?? []).map(c => normKey(c?.name ?? '')))
      return [...topNames].filter(n => !returned.has(normKey(n)))
    }
    let synthData: WorldOverlay | null = null
    let synthErr: Error | null = null
    let lastMissing: string[] = []
    for (let i = 0; i < 2 && !synthData; i++) {
      if (i > 0) await sleep(1500)
      try {
        const data = await synthAttempt()
        const missing = missingCards(data)
        if (missing.length === 0) {
          synthData = data
        } else {
          lastMissing = missing
          warnings.push(`成书输出不完整:缺少 ${missing.length} 张角色卡,正在重试`)
        }
      } catch (e) {
        if (isAborted()) throw new CancelledError()
        // 4xx 业务失败(配额/鉴权)重试无意义,直接中止
        if (!isRetryable(e)) throw new Error(`成书失败: ${(e as Error).message}`, { cause: e })
        synthErr = e as Error
      }
    }
    if (!synthData) {
      if (lastMissing.length) {
        throw new Error(`成书输出不完整:缺少 ${lastMissing.length} 张角色卡(如「${lastMissing.slice(0, 3).join('」「')}」),角色识别残缺。已中止保存,请重新生成世界(已提取部分有缓存,不会重复消耗 token)`)
      }
      throw new Error(`成书失败: ${synthErr?.message ?? '未知错误'}`, { cause: synthErr ?? undefined })
    }
    liveCalls.delete('synth')
    const overlayRaw = synthData

    // 后处理:只保留实体库中的角色;first_appearance 缺失时按出现章节兜底(shared 实现,与预生成脚本共用)
    const characters = finalizeCards(overlayRaw, entities, topNames)

    overlay = {
      title: overlayRaw.title || title,
      genre: ADULT_GENRE,
      summary: overlayRaw.summary || undefined,
      characters,
      ...mergeOverlayMeta(overlayRaw, localSummary)
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
    overlay,
    storyline
  }
  await saveWork(work)
  return { work, usage: { tokensUsed } }
}

// ---- 本地作品库(IndexedDB works) ----

const STORE_WORKS = 'works'

export async function listWorks(): Promise<LocalWork[]> {
  if (typeof indexedDB === 'undefined') return []
  // 按最后操作时间倒序(无 updatedAt 的旧数据回退创建时间)
  return (await db.table(STORE_WORKS).toArray()).sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
  )
}

export async function getWork(id: string): Promise<LocalWork | null> {
  if (typeof indexedDB === 'undefined') return null
  return (await db.table(STORE_WORKS).get(id)) ?? null
}

/** 按来源云端任务 id 查已安装作品(手动下载时判定"该任务是否已装过",防同一任务重复落库) */
export async function getWorkBySourceTask(taskId: string): Promise<LocalWork | null> {
  if (typeof indexedDB === 'undefined' || !taskId) return null
  const all = await db.table(STORE_WORKS).toArray()
  return all.find(w => w.sourceTaskId === taskId) ?? null
}

export async function saveWork(work: LocalWork): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_WORKS).put(JSON.parse(JSON.stringify(work)))
}

export async function deleteWork(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_WORKS).delete(id)
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
