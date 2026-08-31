// scripts/prebuild-presets.ts
// 预置小说「成书」预生成:管理员本机跑一次完整生成管线(与浏览器端 generateWorld 同一套
// shared 纯函数与提示词,保证产物一致),结果写为静态 JSON(public/worlds/<id>.json)随站点部署。
// 用户在预置入口直接使用预生成世界,0 token、秒进选角;自定义生成(扣 token)保留为可选。
//
// 用法:
//   pnpm prebuild:presets [--eco] [--only=巴掌印,撩愈] [--force]
//  - 默认跳过已有结果(可断点续跑);--force 覆盖重跑
//  - 完整模式默认;--eco 走节约模式(无一致性检查、人物卡本地直拼,约省一半 token)
//  - AI 配置直接写在下方 SCRIPT_AI_CONFIG(脚本专用,独立于控制台/网页中继配置)
// 跑完后检查 public/worlds/*.json,提交 git 部署即对全用户生效;重新生成重跑 --force 再提交。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNovelBytes } from '../server/utils/novel-parser'
import { buildUpstreamRequest } from '../server/utils/ai-relay'
import type { RelayTarget } from '../server/utils/ai-relay'
import { extractJson } from '../shared/json'
import { billedTokens, finalizeStreamUsage, mergeTokenUsage, normalizeTokenUsage } from '../shared/token-estimate'
import type { ChapterExtraction, ChapterSegment, EntityConflict, StoryBeat, WorldEntities, WorldOverlay } from '../shared/novel'
import {
  assembleStoryline, buildCheckMessages, buildEcoSynthMessages, buildExtractMessages, buildLocalCards,
  buildSynthesizeMessages, emptyExtraction, finalizeCards, mergeExtractions, mergeOverlayMeta,
  normalizeExtraction, quoteByChapter, splitUnits, summarizeWorldLocal, verifyQuotes,
  ECO_EXTRACT_MAX_TOKENS, ECO_SYNTH_MAX_TOKENS, TOP_CHARACTERS
} from '../shared/world-build'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 脚本专用 AI 配置(NewAPI 渠道连接信息;独立于控制台/网页中继配置,只供本脚本使用) ----
// 注意:key 直接写在脚本里,本文件会随 git 提交——仅适用于私有仓库,公开仓库请改回环境变量注入

const SCRIPT_AI_CONFIG = {
  _type: 'newapi_channel_conn' as const,
  url: 'https://api.yhlxj.ai',
  key: 'sk-e7KAh6AbT09ctoNSH9jQW3jNVKIPsB9VaeJWmh9IPuNNmW3f',
  /** 渠道可用模型(grok-4.3 上游故障 502,4.6 已实测可用;JSON 模式/中文指令均正常) */
  model: 'grok-4.6'
}

/** 规范化 base url:去尾部斜杠;不带路径时补 /v1(NewAPI/OpenAI 兼容约定,与 .dev.vars 旧配置同型) */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  try {
    const u = new URL(trimmed)
    if (u.pathname === '/' || u.pathname === '') return `${trimmed}/v1`
  } catch {
    // 非法 URL 交由后续请求报错
  }
  return trimmed
}

const eco = process.argv.includes('--eco')
const force = process.argv.includes('--force')
const onlyArg = process.argv.find(a => a.startsWith('--only='))
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : null
const dirArg = process.argv.find(a => a.startsWith('--dir='))
const srcDir = join(root, dirArg ? dirArg.slice(6) : 'public/txt')
const outDir = join(root, 'public/worlds')

const EXTRACT_CONCURRENCY = 4
const MAX_FAIL_RATIO = 1 / 3
const RELAY_TIMEOUT_MS = 600_000

// ---- AI 配置:来自 SCRIPT_AI_CONFIG(不再读环境变量) ----

const baseUrl = normalizeBaseUrl(SCRIPT_AI_CONFIG.url)
const apiKey = SCRIPT_AI_CONFIG.key
const model = SCRIPT_AI_CONFIG.model

if (!apiKey || !baseUrl) {
  console.error('[prebuild-presets] SCRIPT_AI_CONFIG 缺少 key/url,请检查脚本内的配置')
  process.exit(1)
}

const relay: RelayTarget = { format: 'chat', baseUrl, apiKey, model }

// ---- 工具 ----

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 值得重试的瞬时错误:网络/解析异常、429 限流、5xx 上游错误 */
function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number })?.status
  return status === undefined || status === 429 || status >= 500
}

interface AiCallResult {
  data: unknown
  totalTokens: number
}

/** 单次流式直连上游(免登录免扣费,只消耗你配置的 key)。
 *  必须走流式:上游网关(Cloudflare)对非流式请求有 ~100s 超时(524),
 *  长输出经常被掐断;流式下响应头即回、字节持续到达,不受该限制。 */
async function callAI(
  messages: { role: 'system' | 'user' | 'assistant', content: string }[],
  opts: { maxTokens?: number, temperature: number }
): Promise<AiCallResult> {
  const req = buildUpstreamRequest(relay, {
    messages,
    json: true,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    thinking: false,
    stream: true
  })
  let res: Response
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(`AI 上游请求失败: ${(e as Error).message}`, { cause: e })
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const err = new Error(`AI 上游错误 (${res.status}): ${detail.slice(0, 300)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  if (!res.body) throw new Error('上游未返回流式响应体')

  // 解析 OpenAI 兼容 SSE:累计 delta.content,取流尾 usage 分片
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let mergedUsage: ReturnType<typeof normalizeTokenUsage> | undefined
  let done = false
  while (!done) {
    const read = await reader.read()
    if (read.done) break
    buf += decoder.decode(read.value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { done = true; break }
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[]
          usage?: { total_tokens?: number, prompt_tokens?: number, completion_tokens?: number }
        }
        const delta = chunk.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) content += delta
        const u = chunk.usage
        if (u) mergedUsage = mergeTokenUsage(mergedUsage, normalizeTokenUsage(u))
      } catch {
        // 跳过无法解析的分片(心跳/注释行等)
      }
    }
  }
  const data = extractJson(content)
  if (data === null) {
    // 偶发非 JSON 输出:按瞬时错误处理(交由调用方重试)
    throw new Error('AI 返回非 JSON,已按失败处理')
  }
  return { data, totalTokens: billedTokens(finalizeStreamUsage(mergedUsage, messages, content)) }
}

/** 并发池:fn 抛错记为该单元失败(调用方决定跳过或中止) */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
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
        results[i] = await fn(item, i)
      } catch (e) {
        results[i] = e as Error
      }
    }
  })
  await Promise.all(workers)
  return results
}

interface BookResult {
  id: string
  title: string
  ok: boolean
  tokensUsed: number
  error?: string
}

// ---- 元数据解析(与 seed-presets 一致:首行《书名》+ 作者正则 + index.json 覆盖) ----

interface MetaOverride {
  title?: string
  author?: string | null
  genre?: string | null
}

let overrides: Record<string, MetaOverride> = {}
try {
  overrides = JSON.parse(readFileSync(join(srcDir, 'index.json'), 'utf-8'))
} catch {
  // 无覆盖文件则全部自动解析
}

/** 单本书:单段全文 + 元数据(标题/作者/题材);提取按字数分块,不依赖章节结构 */
function loadBook(file: string): { id: string, title: string, author: string | null, genre: string | null, chapters: ChapterSegment[] } {
  const bytes = new Uint8Array(readFileSync(join(srcDir, file)))
  const parsed = parseNovelBytes(bytes, file)
  const id = file.replace(/\.(txt|text)$/i, '')
  const ov = overrides[id] ?? {}
  const decoded = new TextDecoder(parsed.encoding).decode(bytes).replace(/^\uFEFF/, '')
  const firstLine = decoded.split(/\r?\n/, 1)[0]
  const rawTitle = firstLine.match(/《([^《》]+)》/)?.[1]?.trim() ?? parsed.title
  const title = rawTitle.replace(/\s*【[^】]*】\s*/g, '').trim() || rawTitle
  const author = ov.author !== undefined
    ? ov.author
    : decoded.match(/作者\s*[:：]\s*([^\s【】[\]、,，。;；]+)/)?.[1]?.trim() ?? null
  return {
    id,
    title: title.slice(0, 200),
    author: author ? String(author).slice(0, 100) : null,
    genre: ov.genre ?? null,
    chapters: [{ title: '', content: parsed.text }]
  }
}

// ---- 单本成书管线(与 generateWorld 逐阶段一致) ----

async function buildWorld(book: { id: string, title: string, chapters: ChapterSegment[] }): Promise<{
  title: string
  overlay: WorldOverlay
  entities: WorldEntities
  conflicts: EntityConflict[]
  warnings: string[]
  storyline: StoryBeat[]
  tokensUsed: number
}> {
  const { title, chapters } = book
  const warnings: string[] = []
  let tokensUsed = 0

  // 1) 分块提取(并发 4,瞬时错误退避 1.5s 重试一次后记为该单元失败)
  const units = splitUnits(chapters)
  const extracts: (ChapterExtraction | null)[] = new Array(units.length)
  const results = await pool(units, EXTRACT_CONCURRENCY, async (unit) => {
    const t0 = Date.now()
    const attempt = async (): Promise<ChapterExtraction> => {
      const { data, totalTokens } = await callAI(buildExtractMessages(title, unit, eco), {
        maxTokens: eco ? ECO_EXTRACT_MAX_TOKENS : undefined,
        temperature: 0.2
      })
      tokensUsed += totalTokens
      return normalizeExtraction(data)
    }
    // 上游偶发把请求卡到网关 524(约 100s 超时,同尺寸请求时快时慢):5 轮指数退避重试
    let out: ChapterExtraction | null = null
    let lastErr: unknown
    for (let round = 0; round < 5; round++) {
      try {
        out = await attempt()
        break
      } catch (e) {
        lastErr = e
        if (!isRetryable(e)) break
        await sleep(3000 * 2 ** round)
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    if (out) {
      console.log(`    · 单元 ${unit.label} ✓ ${secs}s`)
      return out
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
    console.warn(`    · 单元 ${unit.label} ✗ ${secs}s: ${msg}`)
    return lastErr instanceof Error ? lastErr : new Error(msg)
  })
  let okCount = 0
  results.forEach((r, i) => {
    if (r instanceof Error) {
      warnings.push(`单元「${units[i]?.label ?? `#${i + 1}`}」提取失败: ${r.message}`)
      extracts[i] = null
    } else {
      okCount++
      extracts[i] = r
    }
  })
  if (units.length > 0 && okCount / units.length <= 1 - MAX_FAIL_RATIO) {
    throw new Error(`提取失败率过高(${units.length - okCount}/${units.length}),已中止`)
  }

  // 2) 合并 + 引用校验(按段快照为角色生成阶段变体)
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

  // 3) 一致性检查(完整模式;瞬时错误退避 1.5s 重试一次,仍失败降级为告警,不中止)
  if (!eco && entities.characters.length + entities.locations.length + entities.world_rules.length > 0) {
    const applyCheck = (data: unknown) => {
      const checkData = (data ?? {}) as {
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
          id: crypto.randomUUID(),
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
    const checkAttempt = async () => {
      const { data } = await callAI(buildCheckMessages(title, entities, conflicts), {
        temperature: 0.2
      })
      applyCheck(data)
    }
    try {
      await checkAttempt()
    } catch (e) {
      // 瞬时错误(限流/偶发非 JSON)退避重试一次,与浏览器端管线一致
      if (!isRetryable(e)) {
        warnings.push(`一致性检查失败: ${(e as Error).message}(仅保留代码检测冲突)`)
      } else {
        await sleep(1500)
        try {
          await checkAttempt()
        } catch (e2) {
          warnings.push(`一致性检查失败: ${(e2 as Error).message}(仅保留代码检测冲突)`)
        }
      }
    }
  } else if (eco) {
    warnings.push('节约模式:已跳过 AI 一致性检查,仅保留代码检测到的设定冲突(可在编辑页人工复核)')
  }

  // 4) 成书
  let overlay: WorldOverlay
  if (eco) {
    let ecoSynth: (WorldOverlay & { roles?: { name?: string, role?: string }[] }) | null = null
    try {
      const { data } = await callAI(buildEcoSynthMessages(title, entities, localSummary), {
        maxTokens: ECO_SYNTH_MAX_TOKENS,
        temperature: 0.3
      })
      ecoSynth = (data ?? {}) as WorldOverlay & { roles?: { name?: string, role?: string }[] }
    } catch (e) {
      warnings.push(`节约模式:成书概览生成失败(${(e as Error).message}),人物卡已按提取素材直接生成`)
    }
    overlay = {
      title: ecoSynth?.title?.trim() || title,
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
    let synthData: WorldOverlay
    try {
      const { data } = await callAI(buildSynthesizeMessages(title, entities, conflicts, warnings, localSummary), {
        temperature: 0.3
      })
      synthData = (data ?? {}) as WorldOverlay
    } catch (e) {
      if (!isRetryable(e)) throw new Error(`成书失败: ${(e as Error).message}`, { cause: e })
      await sleep(1500)
      try {
        const { data } = await callAI(buildSynthesizeMessages(title, entities, conflicts, warnings, localSummary), {
          temperature: 0.3
        })
        synthData = (data ?? {}) as WorldOverlay
      } catch (e2) {
        throw new Error(`成书失败: ${(e2 as Error).message}`, { cause: e2 })
      }
    }
    overlay = {
      title: synthData.title?.trim() || title,
      summary: synthData.summary?.trim() || undefined,
      characters: finalizeCards(synthData, entities, topNames),
      ...mergeOverlayMeta(synthData, localSummary)
    }
  }

  return {
    title: overlay.title || title,
    overlay,
    entities,
    conflicts,
    warnings,
    storyline,
    tokensUsed
  }
}

// ---- 主流程 ----

const files = readdirSync(srcDir).filter(f => /\.(txt|text)$/i.test(f)).sort()
if (files.length === 0) {
  console.error(`[prebuild-presets] 目录中没有 TXT: ${srcDir}`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const targets = files.map(loadBook).filter(b => !only || only.includes(b.id))
if (only) {
  const missing = only.filter(id => !targets.some(b => b.id === id))
  if (missing.length) console.warn(`[prebuild-presets] 未找到: ${missing.join(', ')}`)
}

console.log(`[prebuild-presets] 模式=${eco ? 'eco(节约)' : 'full(完整)'} 目标=${targets.length} 本 key=${baseUrl}(${model})`)
console.log(`[prebuild-presets] 输出目录: ${outDir}(已存在且未 --force 的跳过)`)
if (eco) console.warn('[prebuild-presets] 注意:节约模式产物与浏览器端「节约」生成一致,建议正式跑用完整模式')

const results: BookResult[] = []
for (const book of targets) {
  const outFile = join(outDir, `${book.id}.json`)
  if (!force && existsSync(outFile)) {
    console.log(`  - 跳过 ${book.title}(${book.id}):worlds/${book.id}.json 已存在(--force 覆盖)`)
    results.push({ id: book.id, title: book.title, ok: true, tokensUsed: 0 })
    continue
  }
  const t0 = Date.now()
  try {
    const world = await buildWorld(book)
    const payload = {
      id: book.id,
      title: world.title,
      author: book.author,
      genre: book.genre,
      summary: world.overlay.summary ?? null,
      characters: world.overlay.characters ?? [],
      overlay: world.overlay,
      storyline: world.storyline,
      entities: world.entities,
      conflicts: world.conflicts,
      warnings: world.warnings,
      tokensUsed: world.tokensUsed,
      mode: eco ? 'eco' : 'full',
      generatedAt: new Date().toISOString(),
      version: 2
    }
    writeFileSync(outFile, JSON.stringify(payload), 'utf-8')
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`  ✓ ${book.title}(${book.id}): ${world.tokensUsed.toLocaleString()} tokens, ${(world.overlay.characters ?? []).length} 角色卡, ${world.storyline.length} 细纲, ${world.entities.characters.length} 实体角色, ${world.conflicts.length} 冲突, ${world.warnings.length} 告警, ${secs}s → worlds/${book.id}.json`)
    results.push({ id: book.id, title: book.title, ok: true, tokensUsed: world.tokensUsed })
  } catch (e) {
    console.error(`  ✗ ${book.title}(${book.id}): ${(e as Error).message}`)
    results.push({ id: book.id, title: book.title, ok: false, error: (e as Error).message })
  }
}

const total = results.reduce((s, r) => s + r.tokensUsed, 0)
const failed = results.filter(r => !r.ok)
console.log(`[prebuild-presets] done: ${results.length - failed.length}/${results.length} 本成功,合计 ${total.toLocaleString()} tokens${failed.length ? `, 失败: ${failed.map(f => f.title).join('、')}` : ''}`)
if (failed.length === 0) {
  console.log('[prebuild-presets] 提交 public/worlds/ 并部署即对全用户生效;重新生成重跑 --force')
} else {
  process.exitCode = 1
}
