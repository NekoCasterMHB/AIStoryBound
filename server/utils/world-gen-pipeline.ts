// server/utils/world-gen-pipeline.ts
// 云端世界生成管线:txt 已在 R2,按「解析 → 作者 → 切段提取 → 合并校验 → 检查 → 成书 → 落盘」执行。
// 与浏览器端 generateWorld / 预生成脚本共用 shared/world-build.ts 纯函数,保证产物一致。
//
// 结构约定:
//  - 每个步骤函数幂等(重跑不产生副作用错误),进度与状态实时写 world_gen_tasks 行;
//  - 中间态(合并结果/成书 overlay)写 R2 scratch 前缀,避免塞进 Workflow step 状态或 D1;
//  - 提取单元结果落 world_gen_units 表:断点续跑与 Workflow step 重放时直接跳过已完成单元;
//  - 计费:平台模式创建时仅预检余额(estimated_tokens,不预扣),管线只记账(tokens_used + ai_usage),
//    任务成功完成时一次性从余额扣除实际消耗 tokensUsed(settleTaskOnSuccess,幂等);失败/取消不扣费;
//    用户自建 key 模式解密暂存 key 转发,零扣费仅记账。
//  - 任务终态一律清空 key 暂存列(clearTaskKey),防静态泄露。
import { drizzle } from 'drizzle-orm/d1'
import { and, asc, eq, inArray, lt, or, sql, isNotNull, count } from 'drizzle-orm'
import * as schema from '../db/schema'
import { aiUsage, user as usersTable, worldCache, worldGenTasks, worldGenUnits, aiProviderConfigs } from '../db/schema'
import type { RelayTarget } from './ai-relay'
import { callAiJson, isRetryableError } from './ai-call'
import { decryptJsonWithSecret } from './crypto'
import { getAppConfig } from './config'
import { AI_PURPOSE_ROUTING_KEY } from './ai'
import { isAiApiFormat, AI_ROUTE_ENV } from '../../shared/ai-config'
import { extractFrontMatter, detectAuthorFromFrontMatter, uuid } from '../../shared/novel'
import type {
  ChapterExtraction, CharacterArc, EntityConflict, MergedCharacter, StoryBeat, TokenUsage, WorldEntities, WorldOverlay
} from '../../shared/novel'
import {
  assembleStoryline, buildCharacterArcMessages, buildCheckMessages, buildEcoSynthMessages,
  buildExtractMessages, buildLocalCards, buildSynthesizeMessages, characterArcCandidates, emptyExtraction, finalizeCards,
  mergeExtractions, mergeOverlayMeta, normalizeCharacterArcs, normalizeExtraction, quoteByChapter, splitUnits,
  summarizeWorldLocal, verifyQuotes, ECO_EXTRACT_MAX_TOKENS, ECO_SYNTH_MAX_TOKENS, TOP_CHARACTERS,
  ARC_WINDOW_BEAT_LIMIT, ARC_WINDOW_CHARS
} from '../../shared/world-build'
import type { ExtractUnit, WorldLocalSummary } from '../../shared/world-build'
import type { WorldGenMode, WorldGenStageDetail } from '../../shared/world-gen-task'
import { parseWorldGenSteps } from '../../shared/world-gen-task'
import { billedTokens } from '../../shared/token-estimate'
import { buildEntityLinkMessages, clusterCharacterCandidates, parseEntityLinkGroups, applyEntityMerges } from '../../shared/entity-link'
import { parseNovelBytes } from './novel-parser'
import {
  ANNOTATE_CHUNK_BEATS, buildAnnotateMessages, buildBookDoc, groupBeats, normalizeSegmentAnnotations,
  remapArcsToSegments
} from '../../shared/book-build'
import type { AnnotateBeat, ChapterExtractStatuses, SegmentAnnotation } from '../../shared/book-build'
import { bookDocToZip } from '../../shared/novel-v2'

/** 单本允许的最大提取失败率(超过则中止;与浏览器端 MAX_FAIL_RATIO 一致) */
const MAX_FAIL_RATIO = 1 / 3
/** 提取并发(与浏览器端 EXTRACT_CONCURRENCY 一致) */
export const EXTRACT_CONCURRENCY = 4
/** arcs 任务创建时余额预检的输出预留估算(tokens);实际调用不设 maxTokens,输出上限交给上游模型自身 */
export const ARCS_UNIT_OUTPUT_RESERVE = 8000
/** running 状态超过该时长视为孤儿(Workflow 被强杀/执行环境异常),由状态接口兜底判失败并退款;
 *  正常运行时提取单元会持续更新任务行,最长的静默段是检查/成书的单次 AI 调用(约 10 分钟),30 分钟足够安全 */
const STALE_RUNNING_MS = 30 * 60 * 1000

/** 部署/代码更新重置正在运行的 Workflow 实例时,平台抛出的两类错误(DO 内存清零,持久化状态不受影响)。
 *  这类错误不是任务失败:管线步骤全部幂等,应自动另起新实例续跑,而不是判失败展示给用户。 */
const DEPLOY_RESET_ERROR_RE = /Durable Object reset because its code was updated|This script has been upgraded/i

export function isDeployResetError(message: string): boolean {
  return DEPLOY_RESET_ERROR_RE.test(message)
}

// ---- R2 key 约定 ----

/** 原文 key(按 hash 去重,同一文件全站只存一份) */
export function worldSourceKey(hash: string): string {
  return `world-gen/sources/${hash}.txt`
}

/** 成书 world json 的公开缓存 key(旧版 v1 产物遗留键约定;v2 单轨后仅旧任务存量使用) */
export function worldCacheObjectKey(hash: string, mode: string): string {
  return `world-cache/${hash}-${mode}.json`
}

/** 成书 v2(aisb-book)zip 的缓存 key(确定性:由 hash+mode 即可反查,无需任务行新增列) */
export function book2CacheObjectKey(hash: string, mode: string): string {
  return `world-cache/${hash}-${mode}.book2.zip`
}

/** arcs 任务建任务时正文 spool 的 R2 键(正文不进 D1 payload;在任务 scratch 前缀下,终态删除) */
export function arcsTextInputKey(taskId: string): string {
  return scratchKey(taskId, 'arcs-text')
}

function scratchPrefix(taskId: string): string {
  return `world-gen/scratch/${taskId}/`
}

function scratchKey(taskId: string, name: string): string {
  return `${scratchPrefix(taskId)}${name}.json`
}

// ---- 环境/上下文 ----

/** 管线所需的最小 env 结构(Workflow 与 API 上下文都满足) */
export interface WorldGenEnv {
  DB: D1Database
  SKILL_FILES: R2Bucket
  /** 自建 key 暂存与平台配置 apiKey 的 AES-GCM 密钥来源(crypto.ts HKDF 派生) */
  BETTER_AUTH_SECRET?: string
  AI_BASE_URL?: string
  AI_API_KEY?: string
  AI_MODEL?: string
}

export function createWorldGenDb(DB: D1Database) {
  return drizzle(DB, { schema })
}

export type WorldGenDb = ReturnType<typeof createWorldGenDb>

export type WorldGenTaskRow = typeof worldGenTasks.$inferSelect

export function createWorldGenCtx(env: WorldGenEnv, taskId: string) {
  const db = createWorldGenDb(env.DB)
  return {
    db,
    bucket: env.SKILL_FILES,
    env,
    taskId,
    /** 平台/用户 relay 的惰性缓存(同一上下文内复用;Workflow 每个 step 新建 ctx,天然按步刷新) */
    relayPromise: null as Promise<RelayTarget> | null,
    /** 源文解析惰性缓存:同一 isolate 存活期内只做一次全文下载+解析(提取每单元、merge/arcs/finalize 都要取文)。
     *  源文只读、结果确定,isolate 重放/续跑时重取一次无正确性风险;不缓存则每个单元一次全文往返。 */
    sourcePromise: null as Promise<{ units: ExtractUnit[], text: string }> | null
  }
}

export type WorldGenCtx = ReturnType<typeof createWorldGenCtx>

/** 只需 db + taskId 的窄接口(计费/状态写入;孤儿清扫等无 R2 场景复用) */
export interface TaskRef {
  db: WorldGenDb
  taskId: string
}

// ---- 任务行读写 ----

export async function requireTask(ctx: TaskRef): Promise<WorldGenTaskRow> {
  const task = await ctx.db.select().from(worldGenTasks).where(eq(worldGenTasks.id, ctx.taskId)).get()
  if (!task) throw new Error(`任务不存在: ${ctx.taskId}`)
  return task
}

/** 任务被取消则抛出(各步骤入口检查,提前终止管线) */
export async function assertNotCancelled(task?: WorldGenTaskRow): Promise<void> {
  const t = task
  if (t?.status === 'cancelled') throw new WorldGenCancelledError()
}

export class WorldGenCancelledError extends Error {
  constructor() {
    super('任务已取消')
  }
}

/** 历史防御:旧逐笔扣费模型下余额不足抛此错误转 paused;当前成功才结算,结算失败在 settleTaskOnSuccess 内直接转 paused,不再抛出 */
export class InsufficientTokensError extends Error {
  constructor() {
    super('token 余额不足,任务已暂停;充值后可在书架「云端生成任务」中继续')
  }
}

export async function markTask(ctx: TaskRef, patch: Partial<typeof worldGenTasks.$inferInsert>): Promise<void> {
  await ctx.db.update(worldGenTasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(worldGenTasks.id, ctx.taskId))
    .run()
}

type ExtendedStageDetail = WorldGenStageDetail & { plan?: { chapter: number, label: string, startChar: number, chars: number }[] }

export function parseStageDetail(raw: string | null): ExtendedStageDetail {
  try {
    const d = raw ? JSON.parse(raw) as ExtendedStageDetail : null
    if (d && typeof d === 'object') {
      return {
        doneUnits: d.doneUnits ?? 0,
        totalUnits: d.totalUnits ?? 0,
        plan: d.plan,
        synthDone: d.synthDone,
        arcs: d.arcs,
        annotate: d.annotate
      }
    }
  } catch {
    // 损坏按空处理
  }
  return { doneUnits: 0, totalUnits: 0 }
}

/** stage_detail 合并写:保留既有字段(plan 与并行分支子进度),只覆盖指定分支槽位。
 *  并行收尾分支(synthesize/arcs/annotate)各自写自己的槽位,不得整写 stage_detail 互相覆盖。 */
async function mergeStageDetail(ctx: TaskRef, patch: Pick<ExtendedStageDetail, 'synthDone' | 'arcs' | 'annotate'>): Promise<void> {
  const task = await requireTask(ctx)
  const d = parseStageDetail(task.stageDetail)
  await markTask(ctx, { stageDetail: JSON.stringify({ ...d, ...patch }) })
}

// ---- 计费与账目 ----

/**
 * 累计实耗:只记账(ai_usage 明细 + tokens_used 增量),不扣余额。
 * 平台模式的扣费延迟到任务成功完成时一次性结算(settleTaskOnSuccess),失败/取消不扣费。
 */
export async function recordTaskUsage(ctx: TaskRef, task: WorldGenTaskRow, usage: TokenUsage): Promise<void> {
  const tokens = billedTokens(usage)
  if (tokens <= 0) return
  try {
    // 明细 + 增量同一 batch(单次 D1 往返);批内一条失败整批回滚,语义与逐条一致
    await ctx.db.batch([
      ctx.db.insert(aiUsage).values({
        id: uuid(),
        userId: task.userId,
        taskId: ctx.taskId,
        tokens,
        promptTokens: usage.promptTokens ?? 0,
        completionTokens: usage.completionTokens ?? 0,
        createdAt: new Date()
      }),
      ctx.db.update(worldGenTasks)
        .set({ tokensUsed: sql`${worldGenTasks.tokensUsed} + ${tokens}`, updatedAt: new Date() })
        .where(eq(worldGenTasks.id, ctx.taskId))
    ])
  } catch (e) {
    console.error('[world-gen] 用量记账失败', { taskId: ctx.taskId, tokens }, e)
  }
}

/**
 * 任务成功完成时的结算:一次性从平台余额扣除实际消耗 tokensUsed(用户自建 key 不扣、只记账)。
 * 返回 false 表示余额不足,任务已转 paused(已完成待结算;结果与共享缓存均暂不可用,充值后可继续)。
 * 幂等:结算成功把 estimatedTokens 清零作为标记,重跑/续跑再进来直接通过,不重复扣费。
 */
export async function settleTaskOnSuccess(ctx: TaskRef): Promise<boolean> {
  const task = await requireTask(ctx)
  if (task.keySource !== 'platform') return true
  const tokens = Math.max(0, task.tokensUsed)
  if (tokens <= 0) return true
  if (task.estimatedTokens <= 0) return true // 已结算(幂等标记)
  const claimed = await ctx.db.update(usersTable)
    .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${tokens}` })
    .where(and(eq(usersTable.id, task.userId), sql`${usersTable.aiTokenBalance} >= ${tokens}`))
    .run()
  if (claimed.meta.changes === 0) {
    await markTaskPaused(ctx, '任务已完成但 token 余额不足,充值后点击「继续任务」完成结算')
    return false
  }
  await markTask(ctx, { estimatedTokens: 0 }) // 已结算标记:重跑/续跑不再重复扣费
  return true
}

/** 清空自建 key 暂存(任务终态必须调用;防库文件/备份静态泄露) */
export async function clearTaskKey(ctx: TaskRef): Promise<void> {
  await ctx.db.update(worldGenTasks)
    .set({ keyCiphertext: null, keyIv: null, updatedAt: new Date() })
    .where(eq(worldGenTasks.id, ctx.taskId))
    .run()
}

/** 失败终态:置状态 + 清 key(Workflow run 顶层 catch 与孤儿清扫共用;仅需 db + taskId)。
 *  运行中不扣费(成功才一次性结算),失败/取消一律不产生扣费。 */
export async function markTaskFailed(ctx: TaskRef, message: string): Promise<void> {
  await markTask(ctx, { status: 'failed', error: message.slice(0, 800) })
  await clearTaskKey(ctx)
}

/** 余额不足终态:任务转 paused(已完成待结算,结果暂不可用;充值后 resume 补扣完成)。运行中不扣费,无预扣可退 */
export async function markTaskPaused(ctx: TaskRef, message: string): Promise<void> {
  await markTask(ctx, { status: 'paused', error: message.slice(0, 800) })
  await clearTaskKey(ctx)
}

/** 失败/取消任务 scratch 垃圾回收:终态超过该天数的前缀整删(completed 的 arcs 任务 scratch 保留
 *  arcs.json 供结果端点读取,不在此列;world 任务 completed 时已自行清理)。单次清扫限额防放大。 */
const SCRATCH_GC_DAYS = 3
const SCRATCH_GC_LIMIT = 20

/**
 * 孤儿任务兜底(状态查询接口周期调用):
 *  - running 超时(STALE_RUNNING_MS)→ 判失败(运行中不扣费,失败即免费;旧预扣退款已移除);
 *  - 终态仍带 key 暂存 → 清空(强杀残留);
 *  - failed/cancelled 任务过期 scratch 前缀 → R2 回收(传 bucket 时启用)。
 */
export async function sweepStaleWorldGenTasks(db: WorldGenDb, bucket?: R2Bucket): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS)
  const now = new Date()
  try {
    // running 超时 → failed(数量极少,不值得批量优化)
    const staleRunning = await db.select({ id: worldGenTasks.id })
      .from(worldGenTasks)
      .where(and(eq(worldGenTasks.status, 'running'), lt(worldGenTasks.updatedAt, staleBefore)))
      .all()
    for (const t of staleRunning) {
      const ref: TaskRef = { db, taskId: t.id }
      await markTask(ref, { status: 'failed', error: '任务超时未完成(执行环境中断),运行中未产生扣费' })
      await clearTaskKey(ref)
    }
    // 终态残留 key → 清空
    await db.update(worldGenTasks)
      .set({ keyCiphertext: null, keyIv: null, updatedAt: now })
      .where(and(
        inArray(worldGenTasks.status, ['completed', 'failed', 'cancelled']),
        or(isNotNull(worldGenTasks.keyCiphertext), isNotNull(worldGenTasks.keyIv))
      ))
      .run()
    // 失败/取消任务的 scratch 回收(merged/overlay/检查点等中间产物,任务已终态无再利用价值)
    if (bucket) {
      const gcBefore = new Date(now.getTime() - SCRATCH_GC_DAYS * 24 * 60 * 60 * 1000)
      const doomed = await db.select({ id: worldGenTasks.id })
        .from(worldGenTasks)
        .where(and(
          inArray(worldGenTasks.status, ['failed', 'cancelled']),
          lt(worldGenTasks.updatedAt, gcBefore)
        ))
        .limit(SCRATCH_GC_LIMIT)
        .all()
      for (const t of doomed) {
        try {
          let cursor: string | undefined
          do {
            const list = await bucket.list({ prefix: scratchPrefix(t.id), cursor })
            for (const obj of list.objects) await bucket.delete(obj.key)
            cursor = list.truncated ? list.cursor : undefined
          } while (cursor)
        } catch (e) {
          console.error('[world-gen] 终态任务 scratch 回收失败', { taskId: t.id }, e)
        }
      }
    }
  } catch (e) {
    console.error('[world-gen] 孤儿任务清扫失败', e)
  }
}

// ---- Relay 解析 ----

/** 平台 relay:D1 用途路由/启用行(AES-GCM 解密)→ env 兜底(与 server/utils/ai.ts 同链路,免 H3Event 版)。
 *  可多行同时启用(路由候选);路由可指向配置行或环境变量(AI_ROUTE_ENV),未路由时按创建时间取最早的一条。 */
export async function resolvePlatformRelay(env: WorldGenEnv, db: WorldGenDb): Promise<RelayTarget | null> {
  const secret = env.BETTER_AUTH_SECRET ?? ''
  let cfgRow: typeof aiProviderConfigs.$inferSelect | undefined
  try {
    const routingRaw = await getAppConfig(db, AI_PURPOSE_ROUTING_KEY)
    let routedId: string | null | undefined
    if (routingRaw) {
      try {
        const parsed = JSON.parse(routingRaw) as Partial<Record<string, string | null>>
        routedId = parsed.worldGen
      } catch {
        // 解析失败走默认链
      }
    }
    if (routedId === AI_ROUTE_ENV) {
      return envRelay(env)
    }
    if (routedId) {
      cfgRow = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.id, routedId)).get()
    }
    if (!cfgRow) {
      cfgRow = await db.select().from(aiProviderConfigs)
        .where(eq(aiProviderConfigs.active, 1))
        .orderBy(asc(aiProviderConfigs.createdAt))
        .limit(1)
        .get()
    }
  } catch (e) {
    console.error('[world-gen] 平台配置读取失败,回退 env', e)
  }
  if (cfgRow?.baseUrl && cfgRow?.model) {
    const apiKey = secret ? await decryptJsonWithSecret<string>(secret, cfgRow.apiKeyCiphertext, cfgRow.apiKeyIv) : null
    if (apiKey) {
      return { format: isAiApiFormat(cfgRow.format) ? cfgRow.format : 'chat', baseUrl: cfgRow.baseUrl.replace(/\/+$/, ''), apiKey, model: cfgRow.model }
    }
    console.error('[world-gen] 平台配置 apiKey 解密失败(BETTER_AUTH_SECRET 不一致?)')
  }
  return envRelay(env)
}

/** 环境变量兜底 relay(部署注入 AI_BASE_URL/AI_API_KEY/AI_MODEL;未配置返回 null) */
function envRelay(env: WorldGenEnv): RelayTarget | null {
  if (env.AI_API_KEY && env.AI_BASE_URL) {
    return { format: 'chat', baseUrl: env.AI_BASE_URL.replace(/\/+$/, ''), apiKey: env.AI_API_KEY, model: env.AI_MODEL || 'gpt-4o-mini' }
  }
  return null
}

/** 任务执行 relay:用户自建 key(解密暂存)优先,否则平台配置 */
export async function resolveTaskRelay(ctx: WorldGenCtx, task: WorldGenTaskRow): Promise<RelayTarget> {
  if (task.keySource === 'user') {
    if (!task.keyCiphertext || !task.keyIv) throw new Error('用户自建 key 暂存缺失,无法执行任务')
    const secret = ctx.env.BETTER_AUTH_SECRET ?? ''
    const cfg = await decryptJsonWithSecret<{ format?: string, baseUrl?: string, apiKey?: string, model?: string }>(secret, task.keyCiphertext, task.keyIv)
    if (!cfg?.baseUrl || !cfg?.apiKey || !cfg?.model) throw new Error('用户自建 key 解密失败(密钥变更?),任务中止')
    return { format: isAiApiFormat(cfg.format) ? cfg.format : 'chat', baseUrl: cfg.baseUrl.replace(/\/+$/, ''), apiKey: cfg.apiKey, model: cfg.model }
  }
  const relay = await resolvePlatformRelay(ctx.env, ctx.db)
  if (!relay) throw new Error('平台 AI 未配置,无法执行云端生成')
  return relay
}

/** ctx 内复用同一 relay(仅 inline 兜底的长生命周期 ctx 生效;Workflow 每步新 ctx 按步刷新) */
async function relayOf(ctx: WorldGenCtx, task: WorldGenTaskRow): Promise<RelayTarget> {
  if (!ctx.relayPromise) {
    ctx.relayPromise = resolveTaskRelay(ctx, task)
  }
  return ctx.relayPromise
}

// ---- 正文读取与切段 ----

async function fetchSourceText(ctx: WorldGenCtx, task: WorldGenTaskRow): Promise<string> {
  const key = task.sourceKey || worldSourceKey(task.sourceHash)
  const obj = await ctx.bucket.get(key)
  if (!obj) throw new Error(`R2 源文件缺失: ${key}`)
  const bytes = new Uint8Array(await obj.arrayBuffer())
  return parseNovelBytes(bytes, `${task.title || 'novel'}.txt`).text
}

/** 从全文确定性重建提取单元(内容不进 Workflow step 状态/D1;同一 isolate 存活期内复用一次下载+解析) */
async function deriveUnits(ctx: WorldGenCtx, task: WorldGenTaskRow): Promise<{ units: ExtractUnit[], text: string }> {
  if (!ctx.sourcePromise) {
    ctx.sourcePromise = fetchSourceText(ctx, task).then(text => ({ units: splitUnits([{ title: '', content: text }]), text }))
  }
  return ctx.sourcePromise
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- 管线步骤(全部幂等;Workflow step 与 inline 兜底共用) ----

export interface ParseOutcome {
  title: string
  encoding: string
  /** 正则从书名页/前言识别的作者(未识别为 null,由 author 步骤 AI 兜底) */
  author: string | null
  totalChars: number
}

/** 步骤 1:R2 取原文 → 解析(编码/清洗)→ 书名页正则识别作者,写回任务行 */
export async function stepParseSource(ctx: WorldGenCtx): Promise<ParseOutcome> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  const key = task.sourceKey || worldSourceKey(task.sourceHash)
  const obj = await ctx.bucket.get(key)
  if (!obj) throw new Error(`R2 源文件缺失: ${key}`)
  const bytes = new Uint8Array(await obj.arrayBuffer())
  const parsed = parseNovelBytes(bytes, `${task.title || 'novel'}.txt`)
  if (!parsed.text.trim()) throw new Error('正文为空,无法生成世界')
  const author = detectAuthorFromFrontMatter(extractFrontMatter(parsed.text, 3000))
  await markTask(ctx, {
    stage: 'author',
    title: parsed.title || task.title,
    author: author ?? task.author ?? null,
    encoding: parsed.encoding
  })
  return { title: parsed.title || task.title || '', encoding: parsed.encoding, author, totalChars: parsed.totalChars }
}

/** 按模式/开关判断某 AI 步骤是否执行:full=全开,eco=仅 author(其余跳过),custom=按 payload 开关 */
export function stepEnabled(task: Pick<WorldGenTaskRow, 'mode' | 'payload'>, step: 'author' | 'check' | 'synth' | 'arcs'): boolean {
  if (task.mode === 'eco') return step === 'author'
  if (task.mode === 'custom') {
    const steps = parseWorldGenSteps(task.payload)
    return steps[step]
  }
  return true // full
}

/** 作者 AI 兜底:正则未识别时,用书名页片段请模型判断(可失败,失败仅视为未识别) */
export async function stepAuthorAi(ctx: WorldGenCtx): Promise<string | null> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  if (task.author) return task.author
  // 持久化检查点:已识别过直接跳过(重跑/续跑不重复扣费)
  const done = await getScratch<{ author: string | null }>(ctx, 'author-done')
  if (done) {
    if (done.author && done.author !== task.author) await markTask(ctx, { author: done.author })
    return done.author
  }
  const text = await fetchSourceText(ctx, task)
  const front = extractFrontMatter(text, 3000)
  if (!front.trim()) {
    await putScratch(ctx, 'author-done', { author: null })
    return null
  }
  try {
    const relay = await relayOf(ctx, task)
    const { data, usage } = await callAiJson(relay, {
      messages: [
        { role: 'system', content: '你必须只输出一个合法的 JSON 对象。' },
        { role: 'user', content: `以下是一本小说《${task.title ?? ''}》的书名页/开头片段。请判断原著作者名;无法确定填 null。只输出 {"author": "作者名|null"}。\n\n${front.slice(0, 2000)}` }
      ],
      maxTokens: 200,
      temperature: 0
    })
    await recordTaskUsage(ctx, task, usage)
    const author = typeof (data as { author?: unknown })?.author === 'string' ? (data as { author: string }).author.trim() : ''
    if (author && author !== 'null' && author.length <= 100) {
      await putScratch(ctx, 'author-done', { author })
      await markTask(ctx, { author })
      return author
    }
    await putScratch(ctx, 'author-done', { author: null })
  } catch (e) {
    // 余额不足为致命错误:终止任务;其余作者识别失败不中止管线
    if (e instanceof InsufficientTokensError) throw e
  }
  return null
}

export interface UnitPlanEntry {
  chapter: number
  label: string
  startChar: number
  chars: number
}

export interface UnitPlan {
  units: UnitPlanEntry[]
  totalChars: number
}

/** 步骤 2:切段计划(元数据入 stage_detail;单元内容由各提取步骤从 R2 确定性重算) */
export async function stepPlanUnits(ctx: WorldGenCtx): Promise<UnitPlan> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  const { units, text } = await deriveUnits(ctx, task)
  if (units.length === 0) throw new Error('正文为空,无法生成世界')
  const plan: UnitPlan = {
    units: units.map(u => ({ chapter: u.chapter, label: u.label, startChar: u.startChar, chars: u.content.length })),
    totalChars: text.length
  }
  await markTask(ctx, {
    stage: 'extract',
    stageDetail: JSON.stringify({ doneUnits: 0, totalUnits: units.length, plan: plan.units })
  })
  return plan
}

/** 步骤 1+2:解析(编码/清洗/作者正则)+ 切段计划,两个纯代码步合成一个(少一次 workflow step 与 DB 往返) */
export async function stepParseAndPlan(ctx: WorldGenCtx): Promise<{ parsed: ParseOutcome, plan: UnitPlan }> {
  const parsed = await stepParseSource(ctx)
  const plan = await stepPlanUnits(ctx)
  return { parsed, plan }
}

/** 提取完成数刷新(stage_detail.doneUnits;保留 plan 等既有字段)。
 *  2s 节流:同一 isolate 内并发的多个单元完成只触发一次写(跨 isolate 至多各一次,无正确性影响)。 */
let lastExtractBumpAt = 0
async function bumpExtractProgress(ctx: TaskRef, totalUnits: number): Promise<void> {
  const now = Date.now()
  if (now - lastExtractBumpAt < 2000) return
  lastExtractBumpAt = now
  const task = await requireTask(ctx)
  const detail = parseStageDetail(task.stageDetail)
  const c = await ctx.db.select({ n: count() }).from(worldGenUnits).where(eq(worldGenUnits.taskId, ctx.taskId)).get()
  await markTask(ctx, { stageDetail: JSON.stringify({ doneUnits: c?.n ?? 0, totalUnits, plan: detail.plan }) })
}

/**
 * 步骤 3(每单元):幂等提取。
 * 已成功的单元直接跳过(断点续跑/step 重放);失败返回 ok:false(失败率由 merge 步骤裁决),
 * 瞬时错误内部退避重试 2 轮,Workflow step 重试作为外层兜底。
 */
export async function extractUnitAt(ctx: WorldGenCtx, plan: UnitPlan, index: number): Promise<{ ok: boolean, tokens: number, error?: string }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  const meta = plan.units[index]
  if (!meta) return { ok: false, tokens: 0, error: `单元下标越界: ${index}` }

  // 幂等:已完成单元直接跳过
  const existing = await ctx.db.select({ id: worldGenUnits.unitIndex })
    .from(worldGenUnits)
    .where(and(eq(worldGenUnits.taskId, ctx.taskId), eq(worldGenUnits.unitIndex, index)))
    .get()
  if (existing) {
    const detail = parseStageDetail((await requireTask(ctx)).stageDetail)
    if (detail.doneUnits < detail.totalUnits) await bumpExtractProgress(ctx, detail.totalUnits || plan.units.length)
    return { ok: true, tokens: 0 }
  }

  const { units } = await deriveUnits(ctx, task)
  const unit = units[index]
  if (!unit) return { ok: false, tokens: 0, error: `切段后缺少单元: ${index}` }

  const relay = await relayOf(ctx, task)
  const eco = task.mode === 'eco'
  let lastErr: unknown
  for (let round = 0; round < 3; round++) {
    try {
      const { data, usage } = await callAiJson(relay, {
        messages: buildExtractMessages(task.title || '小说', unit, eco),
        maxTokens: eco ? ECO_EXTRACT_MAX_TOKENS : undefined,
        temperature: 0.2
      })
      const extraction = normalizeExtraction(data)
      // 先扣费再落单元结果:余额不足抛出时本单元不落库,续跑会重跑该单元并重新扣费,不漏账
      await recordTaskUsage(ctx, task, usage)
      const unitTokens = billedTokens(usage)
      await ctx.db.insert(worldGenUnits)
        .values({ taskId: ctx.taskId, unitIndex: index, result: JSON.stringify(extraction), tokens: unitTokens })
        .onConflictDoNothing()
        .run()
      await bumpExtractProgress(ctx, plan.units.length)
      return { ok: true, tokens: unitTokens }
    } catch (e) {
      // 余额不足为致命错误:直接终止任务(带明确消息),不做单元级重试
      if (e instanceof InsufficientTokensError) throw e
      lastErr = e
      await assertNotCancelled(await requireTask(ctx))
      if (!isRetryableError(e)) break
      await sleep(1500 * 2 ** round)
    }
  }
  return { ok: false, tokens: 0, error: lastErr instanceof Error ? lastErr.message : String(lastErr) }
}

// ---- 中间态(R2 scratch):合并结果与成书 overlay ----

interface MergedState {
  entities: WorldEntities
  conflicts: EntityConflict[]
  warnings: string[]
  storyline: StoryBeat[]
  localSummary: WorldLocalSummary
}

async function putScratch(ctx: WorldGenCtx, name: string, value: unknown): Promise<void> {
  await ctx.bucket.put(scratchKey(ctx.taskId, name), JSON.stringify(value))
}

export async function getScratch<T>(ctx: WorldGenCtx, name: string): Promise<T | null> {
  const obj = await ctx.bucket.get(scratchKey(ctx.taskId, name))
  if (!obj) return null
  try {
    return JSON.parse(await obj.text()) as T
  } catch {
    return null
  }
}

export async function cleanupScratch(ctx: WorldGenCtx): Promise<void> {
  try {
    let cursor: string | undefined
    do {
      const list = await ctx.bucket.list({ prefix: scratchPrefix(ctx.taskId), cursor })
      for (const obj of list.objects) await ctx.bucket.delete(obj.key)
      cursor = list.truncated ? list.cursor : undefined
    } while (cursor)
  } catch (e) {
    console.error('[world-gen] scratch 清理失败', { taskId: ctx.taskId }, e)
  }
}

/** arcs 任务完成时的正文 spool 清理(最大垃圾对象;结果 arcs.json 保留供结果端点读取)。
 *  只在 completed 路径调用:paused(待结算续跑)时 spool 仍被续跑需要,不能删。 */
async function deleteArcsTextInput(ctx: WorldGenCtx): Promise<void> {
  try {
    await ctx.bucket.delete(arcsTextInputKey(ctx.taskId))
  } catch (e) {
    console.error('[world-gen] arcs 正文 spool 清理失败', { taskId: ctx.taskId }, e)
  }
}

/** 步骤 4:合并全部单元提取(代码 Reduce)+ 引用校验 + 故事线 + 本地聚合草稿 → scratch/merged.json */
export async function stepMerge(ctx: WorldGenCtx, planOverride?: UnitPlan): Promise<{ okUnits: number, totalUnits: number, characters: number, storyline: number, warnings: string[] }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  // 切段计划:优先调用方传入(Workflow step 输出/inline 内存),否则读 stage_detail,
  // 都没有时从 R2 原文重新推导(历史任务的进度更新曾覆盖 stage_detail 里的 plan)
  let plan: UnitPlanEntry[] = planOverride?.units ?? parseStageDetail(task.stageDetail).plan ?? []
  if (plan.length === 0) {
    const { units } = await deriveUnits(ctx, task)
    plan = units.map(u => ({ chapter: u.chapter, label: u.label, startChar: u.startChar, chars: u.content.length }))
  }

  const rows = await ctx.db.select({ unitIndex: worldGenUnits.unitIndex, result: worldGenUnits.result })
    .from(worldGenUnits)
    .where(eq(worldGenUnits.taskId, ctx.taskId))
    .all()
  const byIndex = new Map(rows.map(r => [r.unitIndex, r.result]))

  const { units } = await deriveUnits(ctx, task)
  const extracts: (ChapterExtraction | null)[] = plan.map((_, i) => {
    const raw = byIndex.get(i)
    if (!raw) return null
    try {
      return JSON.parse(raw) as ChapterExtraction
    } catch {
      return null
    }
  })
  const okUnits = extracts.filter(Boolean).length
  const warnings: string[] = []
  if (plan.length > 0 && okUnits / plan.length <= 1 - MAX_FAIL_RATIO) {
    throw new Error(`提取失败率过高(${plan.length - okUnits}/${plan.length}),已中止`)
  }
  if (okUnits < plan.length) {
    warnings.push(`${plan.length - okUnits} 个提取单元失败(已跳过,不编造)`)
  }

  const { entities, conflicts } = mergeExtractions(
    extracts.map((ex, i) => ({
      chapter: plan[i]?.chapter ?? units[i]?.chapter ?? i + 1,
      extract: ex ?? emptyExtraction(),
      startChar: plan[i]?.startChar ?? units[i]?.startChar
    }))
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

  const merged: MergedState = { entities, conflicts, warnings, storyline, localSummary }
  await putScratch(ctx, 'merged', merged)
  // 并行收尾分支槽位初始化(各自后续自行推进;arcs 未启用置 null,不参与整体进度)
  await mergeStageDetail(ctx, {
    synthDone: 0,
    arcs: stepEnabled(task, 'arcs') ? { doneUnits: 0, totalUnits: 0 } : null,
    annotate: { doneUnits: 0, totalUnits: 0 }
  })
  // 下一阶段:节约/自定义关 check 时直接进入成书,避免进度停在被跳过的检查阶段
  await markTask(ctx, { stage: stepEnabled(task, 'check') ? 'check' : 'synthesize' })
  return { okUnits, totalUnits: plan.length, characters: entities.characters.length, storyline: storyline.length, warnings }
}

/** 步骤 4.5(全模式,成本极低):实体消歧。
 *  跨单元提取会把同一角色按不同称呼裂成多个条目(「林凡」/「凡哥」/「小凡」),merge 的名字键去重
 *  只能处理完全同名/已提取 alias 的映射。这里代码预聚类(名字模式相似)后逐簇 AI 裁决、
 *  应用合并——实体库干净后,check/synthesize/arcs 的输入自动瘦身,人物卡/弧线候选不再摊薄。
 *  簇级检查点(link-unit-<i>)与总检查点(link-done)保证重跑/续跑不重复扣费;单簇失败降级保留原条目。 */
export async function stepDisambiguate(ctx: WorldGenCtx): Promise<{ clusters: number, mergedAway: number, warnings: string[] }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  if (await getScratch<{ ok: true }>(ctx, 'link-done')) return { clusters: 0, mergedAway: 0, warnings: [] }
  const merged = await getScratch<MergedState>(ctx, 'merged')
  if (!merged) throw new Error('合并结果缺失,无法实体消歧')
  const chars = merged.entities.characters as MergedCharacter[]
  const clusters = clusterCharacterCandidates(chars)
  if (clusters.length === 0) {
    await putScratch(ctx, 'link-done', { ok: true })
    return { clusters: 0, mergedAway: 0, warnings: [] }
  }
  const title = task.title || '未命名小说'
  const warnings: string[] = []
  const groups: number[][] = []
  const relay = await relayOf(ctx, task)
  await pool(clusters.map((_, i) => i), 3, async (ci) => {
    const key = `link-unit-${ci}`
    const done = await getScratch<{ groups: number[][] }>(ctx, key)
    if (done) {
      groups.push(...done.groups)
      return
    }
    try {
      const { system, user } = buildEntityLinkMessages(title, chars, clusters[ci]!)
      const { data, usage } = await callAiJson(relay, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0
      })
      // 先扣费再落结果:余额不足抛出时该簇不落库,续跑重跑并重新扣费,不漏账
      await recordTaskUsage(ctx, task, usage)
      const gs = parseEntityLinkGroups(data, clusters[ci]!)
      await putScratch(ctx, key, { groups: gs })
      groups.push(...gs)
    } catch (e) {
      if (e instanceof InsufficientTokensError) throw e
      warnings.push(`实体消歧第 ${ci + 1}/${clusters.length} 簇失败(保留各条目):${e instanceof Error ? e.message : String(e)}`)
    }
  })
  const before = chars.length
  if (groups.length > 0) {
    merged.entities.characters = applyEntityMerges(chars, groups).characters
    await putScratch(ctx, 'merged', merged)
  }
  await putScratch(ctx, 'link-done', { ok: true })
  return { clusters: clusters.length, mergedAway: before - merged.entities.characters.length, warnings }
}

/** 步骤 5(仅完整模式):AI 一致性检查;失败降级为告警,不中止 */
export async function stepCheck(ctx: WorldGenCtx): Promise<{ warnings: string[] }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  const merged = await getScratch<MergedState>(ctx, 'merged')
  if (!merged) throw new Error('合并结果缺失,无法检查')
  const { entities, conflicts, warnings } = merged
  if (entities.characters.length + entities.locations.length + entities.world_rules.length === 0) {
    await markTask(ctx, { stage: 'synthesize' })
    return { warnings }
  }
  // 持久化检查点:检查已完成(结果已并入 merged)直接跳过,重跑/续跑不重复扣费
  const done = await getScratch<{ ok: true }>(ctx, 'check-done')
  if (done) {
    await putScratch(ctx, 'merged', merged)
    await markTask(ctx, { stage: 'synthesize' })
    return { warnings }
  }
  try {
    const relay = await relayOf(ctx, task)
    const { data, usage } = await callAiJson(relay, {
      messages: buildCheckMessages(task.title || '小说', entities, conflicts),
      temperature: 0.2
    })
    await recordTaskUsage(ctx, task, usage)
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
  } catch (e) {
    // 余额不足为致命错误:终止任务,不降级为告警
    if (e instanceof InsufficientTokensError) throw e
    warnings.push(`一致性检查失败: ${(e as Error).message}(仅保留代码检测冲突)`)
  }
  await putScratch(ctx, 'merged', merged)
  await putScratch(ctx, 'check-done', { ok: true })
  await markTask(ctx, { stage: 'synthesize' })
  return { warnings }
}

/** 步骤 6:成书(完整=AI 速览+人物卡;节约/自定义关润色=轻量概览+本地直拼卡)→ scratch/overlay.json */
export async function stepSynthesize(ctx: WorldGenCtx): Promise<{ cardCount: number, title: string }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  // 持久化检查点:成书已完成直接跳过,重跑/续跑不重复扣费
  const existing = await getScratch<WorldOverlay>(ctx, 'overlay')
  if (existing) {
    await mergeStageDetail(ctx, { synthDone: 1 })
    return { cardCount: (existing.characters ?? []).length, title: existing.title || task.title || '小说' }
  }
  const merged = await getScratch<MergedState>(ctx, 'merged')
  if (!merged) throw new Error('合并结果缺失,无法成书')
  const { entities, conflicts, warnings, localSummary } = merged
  const title = task.title || '小说'
  const relay = await relayOf(ctx, task)
  // 轻量成书:节约模式,或自定义模式关闭了人物卡 AI 润色(行为与节约一致:轻量概览 + 本地直拼卡)
  const synthLight = task.mode === 'eco' || (task.mode === 'custom' && !stepEnabled(task, 'synth'))

  let overlay: WorldOverlay
  if (synthLight) {
    let ecoSynth: (WorldOverlay & { roles?: { name?: string, role?: string }[] }) | null = null
    try {
      const { data, usage } = await callAiJson(relay, {
        messages: buildEcoSynthMessages(title, entities, localSummary),
        maxTokens: ECO_SYNTH_MAX_TOKENS,
        temperature: 0.3
      })
      await recordTaskUsage(ctx, task, usage)
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
    const synthOnce = async () => {
      const { data, usage } = await callAiJson(relay, {
        messages: buildSynthesizeMessages(title, entities, conflicts, warnings, localSummary),
        temperature: 0.3
      })
      await recordTaskUsage(ctx, task, usage)
      return (data ?? {}) as WorldOverlay
    }
    // 成书失败即失败(瞬时错误交由 Workflow step 重试/inline 重跑)
    const synthData = await synthOnce()
    overlay = {
      title: synthData.title?.trim() || title,
      summary: synthData.summary?.trim() || undefined,
      characters: finalizeCards(synthData, entities, topNames),
      ...mergeOverlayMeta(synthData, localSummary)
    }
  }

  await putScratch(ctx, 'overlay', overlay)
  await mergeStageDetail(ctx, { synthDone: 1 })
  return { cardCount: (overlay.characters ?? []).length, title: overlay.title || title }
}

// ---- 配角故事线生成(arcs 补充任务 + world 成书共用,逐单元) ----

/** arcs 任务输入载荷(world_gen_tasks.payload JSON):客户端上传该作品实体库、主线细纲与全书正文 */
interface ArcsTaskPayload {
  entities: WorldEntities
  storyline: StoryBeat[]
  /** 逐段事实底稿(段角色文件的 剧情/状态,客户端从 book2 段文件收集;arcs 精写的事实依据) */
  plots?: { name: string, beatIndex: number, plot?: string | null, status?: string | null }[]
  /** 全书正文的 R2 键(建任务时服务端把 body.text 落 R2:正文可达数 MB,不能塞 D1 payload 列,单值上限 2MB)。
   *  text 为部署前旧任务遗留的 payload 内联正文,仍兼容读取。 */
  text?: string
  textKey?: string
}

function parseArcsPayload(raw: string | null): ArcsTaskPayload | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as ArcsTaskPayload
    if (p && Array.isArray(p.entities?.characters) && Array.isArray(p.storyline)) return p
  } catch {
    // 载荷损坏按缺失处理
  }
  return null
}

/**
 * 配角故事线步骤(arcs 补充任务与 world 成书共用):按候选角色逐单元生成独立故事线。
 *  - 数据来源:arcs 任务读 payload(entities/storyline/text);world 成书读 merged 实体 + R2 原文;
 *  - 进度 = doneUnits/totalUnits(stage 'arcs' 期间客户端按故事线条数展示);
 *  - 每单元一次 AI 调用,运行中只记账不扣费;arcs 任务完成后一次性结算(settleTaskOnSuccess),余额不足转 paused 待补扣;
 *  - 单单元失败(非余额)降级跳过并记 warning;全部失败 → 抛错判 failed;至少 1 条成功 → 完成;
 *  - 结果写 scratch arcs.json(world 任务由 finalize 落盘成书,arcs 任务由 /tasks/[id]/arcs 读取);
 *  - 单元级检查点:每候选结果落 scratch arc-unit-<i>.json,重跑/续跑已完成单元直接跳过,不重复扣费;
 *  - 每单元注入该角色前几个登场段的原文节选,模型据此还原细节(忠实度接近按原文提取)。
 */

/** 配角故事线完成数刷新(按 scratch 单元检查点文件数,重跑时进度单调不减;一次 list 计数,避免逐单元 R2 读)。
 *  arcs 独立任务整写 stage_detail;world 任务写并行分支槽位(不动 stage)。 */
async function bumpArcsProgress(ctx: WorldGenCtx, totalUnits: number): Promise<void> {
  const task = await requireTask(ctx)
  const list = await ctx.bucket.list({ prefix: `${scratchPrefix(ctx.taskId)}arc-unit-` })
  if (task.kind === 'arcs') {
    const detail = parseStageDetail(task.stageDetail)
    await markTask(ctx, { stageDetail: JSON.stringify({ doneUnits: list.objects.length, totalUnits, plan: detail.plan }) })
  } else {
    await mergeStageDetail(ctx, { arcs: { doneUnits: list.objects.length, totalUnits } })
  }
}

export async function stepSupplementArcs(ctx: WorldGenCtx): Promise<{ count: number, warnings: string[] }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)

  // ---- 数据来源:arcs 任务用 payload;world 成书用 merged + R2 原文 ----
  let entities: WorldEntities
  let storyline: StoryBeat[]
  let sourceText: string | null
  let extracts: (ChapterExtractStatuses | null)[] = []
  if (task.kind === 'arcs') {
    const payload = parseArcsPayload(task.payload)
    if (!payload) throw new Error('任务载荷缺失,无法生成配角故事线')
    entities = payload.entities
    storyline = payload.storyline
    sourceText = payload.text ?? null
    if (!sourceText && payload.textKey) {
      const obj = await ctx.bucket.get(payload.textKey)
      sourceText = obj ? await obj.text() : null
    }
    extracts = (payload.plots ?? []).map(p => ({ characters: [{ name: p.name, status: p.status, plot: p.plot }] }))
  } else {
    const merged = await getScratch<MergedState>(ctx, 'merged')
    if (!merged) throw new Error('合并结果缺失,无法生成配角故事线')
    entities = merged.entities
    storyline = merged.storyline
    if (!storyline || storyline.length === 0) return { count: 0, warnings: [] }
    const du = await deriveUnits(ctx, task)
    sourceText = du.text
    extracts = await loadUnitStatuses(ctx, du.units.length)
  }

  const candidates = characterArcCandidates(entities, storyline)
  const totalUnits = candidates.length
  if (totalUnits === 0) {
    // 无候选角色:arcs 任务直接完成(空结果,0 消耗结算恒通过);world 成书静默跳过(由 finalize 落盘)
    if (task.kind === 'arcs') {
      await putScratch(ctx, 'arcs', [])
      await settleTaskOnSuccess(ctx)
      await markTask(ctx, { status: 'completed', stage: 'done', warnings: '[]' })
      await deleteArcsTextInput(ctx)
    }
    return { count: 0, warnings: [] }
  }

  const title = task.title || '未命名小说'
  if (task.kind === 'arcs') {
    await markTask(ctx, { stage: 'arcs', stageDetail: JSON.stringify({ doneUnits: 0, totalUnits }) })
  } else {
    // world 任务:并行收尾阶段,分支进度写独立槽位(stage 停留在 synthesize,由客户端聚合展示)
    await mergeStageDetail(ctx, { arcs: { doneUnits: 0, totalUnits } })
  }

  // 登场段原文窗口:每个候选取前 ARC_WINDOW_BEAT_LIMIT 个登场段、每段 ARC_WINDOW_CHARS 字(startChar 越界/缺失跳过)
  const beatByIndex = new Map(storyline.map(b => [b.index, b]))
  const textWindowOf = (candidate: { beats: number[] }): string => {
    if (!sourceText) return ''
    const parts: string[] = []
    for (const bi of candidate.beats.slice(0, ARC_WINDOW_BEAT_LIMIT)) {
      const beat = beatByIndex.get(bi)
      if (!beat || typeof beat.startChar !== 'number' || beat.startChar < 0 || beat.startChar >= sourceText.length) continue
      parts.push(`【段${bi + 1}】${sourceText.slice(beat.startChar, beat.startChar + ARC_WINDOW_CHARS)}`)
    }
    return parts.join('\n\n')
  }

  const arcs: CharacterArc[] = []
  const warnings: string[] = []
  const relay = await relayOf(ctx, task)
  // 单 step 内并发(与提取同款批量);arcs 数组为同执行环境共享内存,顺序 push 无竞态。
  // 单元级持久化检查点:每个候选的生成结果落 R2 scratch(arc-unit-<i>.json),重跑/续跑时已完成单元直接跳过,不重复扣费。
  await pool(candidates.map((_, i) => i), EXTRACT_CONCURRENCY, async (i) => {
    const candidate = candidates[i]!
    const arcKey = `arc-unit-${i}`
    // 检查点命中:已完成单元直接读回结果聚合
    const doneArc = await getScratch<CharacterArc>(ctx, arcKey)
    if (doneArc) {
      arcs.push(doneArc)
      await bumpArcsProgress(ctx, totalUnits)
      return
    }
    try {
      // 不设 maxTokens:输出上限交给上游模型自身,避免登场段多时被低上限截断丢段
      // 事实底稿:该角色各段的 extract 剧情/状态(事实层);arcs 只做角色中心的叙事精化,事实不得与之冲突
      const arcDrafts = candidate.beats.flatMap(bi => (extracts[bi]?.characters ?? []).map(c => ({ beatIndex: bi, plot: c.plot, status: c.status })))
      const { data, usage } = await callAiJson(relay, {
        messages: buildCharacterArcMessages(title, candidate, storyline, textWindowOf(candidate), arcDrafts),
        temperature: 0.3
      })
      // 先扣费再落结果:余额不足抛出时该条结果不计入,续跑重跑并重新扣费,不漏账
      await recordTaskUsage(ctx, task, usage)
      const normalized = normalizeCharacterArcs(data, storyline, entities.characters)
      if (normalized.length > 0) {
        const arc = normalized[0]!
        await putScratch(ctx, arcKey, arc)
        arcs.push(arc)
      }
      await bumpArcsProgress(ctx, totalUnits)
    } catch (e) {
      if (e instanceof InsufficientTokensError) throw e
      warnings.push(`「${candidate.card.name}」故事线生成失败:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  if (arcs.length === 0) {
    // arcs 补充任务:全部失败 → 判失败;world 成书:降级跳过(不影响成书落盘,告警由 finalize 聚合)
    if (task.kind === 'arcs') throw new Error(warnings[0] ?? '所有角色的故事线均生成失败')
    await mergeStageDetail(ctx, { arcs: { doneUnits: 0, totalUnits } })
    return { count: 0, warnings }
  }
  await putScratch(ctx, 'arcs', arcs)
  // arcs 任务在此完成:先结算(余额不足转 paused,结果保留在 scratch,充值补扣后重跑至此再完成);
  // world 任务保持 running,由 finalize 统一结算并落盘
  if (task.kind === 'arcs') {
    const settled = await settleTaskOnSuccess(ctx)
    if (!settled) return { count: arcs.length, warnings }
  }
  // 完成数按实际检查点校准(失败单元无检查点,不计入)
  const arcList = await ctx.bucket.list({ prefix: `${scratchPrefix(ctx.taskId)}arc-unit-` })
  if (task.kind === 'arcs') {
    await markTask(ctx, {
      status: 'completed',
      stage: 'done',
      stageDetail: JSON.stringify({ doneUnits: arcList.objects.length, totalUnits }),
      warnings: JSON.stringify(warnings.slice(0, 20))
    })
    await deleteArcsTextInput(ctx)
  } else {
    await mergeStageDetail(ctx, { arcs: { doneUnits: arcList.objects.length, totalUnits } })
  }
  return { count: arcs.length, warnings }
}

// ---- 标剧情转折(AI 标注:粗段合并为剧情段 + 转折标题/主角/节点[],产物进 v2 正典,§3.0) ----

/** 标注分块完成数刷新(按 scratch 检查点文件数;写并行分支槽位,与 arcs 分支互不覆盖) */
async function bumpAnnotateProgress(ctx: WorldGenCtx, totalChunks: number): Promise<void> {
  const list = await ctx.bucket.list({ prefix: `${scratchPrefix(ctx.taskId)}annotate-unit-` })
  await mergeStageDetail(ctx, { annotate: { doneUnits: list.objects.length, totalUnits: totalChunks } })
}

/**
 * 步骤 7.6:AI 标剧情转折。输入只给粗段细纲(不重读全文),把相邻粗段合并为剧情段,
 * 判转折标题/叙事主角/事件里程碑(节点[])。分块调用(ANNOTATE_CHUNK_BEATS 段/块,块内合并),
 * 每块持久化检查点(重跑/续跑不重复扣费);单块失败降级跳过(该块粗段各自成段、无节点),
 * 全部失败 = 一粗段一剧情段(v1 桥接行为),不中止任务。
 * 与 synthesize/arcs 并行执行(只依赖 merged.storyline):进度写 stage_detail.annotate 槽位,
 * 告警经返回值交给 finalize 聚合(不再整写 warnings 列)。
 */
export async function stepAnnotate(ctx: WorldGenCtx): Promise<{ groups: number, warnings: string[] }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  const merged = await getScratch<MergedState>(ctx, 'merged')
  const storyline = merged?.storyline ?? []
  if (storyline.length === 0) {
    await putScratch(ctx, 'annotations', [])
    await mergeStageDetail(ctx, { annotate: null })
    return { groups: 0, warnings: [] }
  }
  const beats: AnnotateBeat[] = storyline.map(b => ({
    index: b.index,
    label: b.label ?? '',
    summary: b.summary ?? '',
    cast: b.cast ?? []
  }))
  const warnings: string[] = []
  const annotations: SegmentAnnotation[] = []
  const relay = await relayOf(ctx, task)
  // 检查点命中先行聚合:已完成块直接读回,不重复调用
  const chunkCount = Math.ceil(beats.length / ANNOTATE_CHUNK_BEATS)
  await mergeStageDetail(ctx, { annotate: { doneUnits: 0, totalUnits: chunkCount } })
  await pool(Array.from({ length: chunkCount }, (_, i) => i), 2, async (ci) => {
    const key = `annotate-unit-${ci}`
    const done = await getScratch<SegmentAnnotation[]>(ctx, key)
    if (done) {
      annotations.push(...done)
      await bumpAnnotateProgress(ctx, chunkCount)
      return
    }
    const slice = beats.slice(ci * ANNOTATE_CHUNK_BEATS, (ci + 1) * ANNOTATE_CHUNK_BEATS)
    // 跨块衔接:把上一块末粗段给模型作背景,使其从新剧情段干净起步(块间仍不合并)
    const prevBeat = ci > 0 ? beats[ci * ANNOTATE_CHUNK_BEATS - 1] : undefined
    const prevTail = prevBeat ? { title: prevBeat.label, summary: prevBeat.summary } : undefined
    try {
      const { system, user } = buildAnnotateMessages(task.title || '小说', slice, prevTail)
      const { data, usage } = await callAiJson(relay, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2 })
      // 先扣费再落结果:余额不足抛出时该块不落库,续跑重跑并重新扣费,不漏账
      await recordTaskUsage(ctx, task, usage)
      const groups = normalizeSegmentAnnotations(data, slice)
      await putScratch(ctx, key, groups)
      annotations.push(...groups)
      await bumpAnnotateProgress(ctx, chunkCount)
    } catch (e) {
      if (e instanceof InsufficientTokensError) throw e
      warnings.push(`剧情转折标注失败(第 ${ci + 1}/${chunkCount} 块,已降级为单粗段):${e instanceof Error ? e.message : String(e)}`)
    }
  })
  annotations.sort((a, b) => a.beats[0]! - b.beats[0]!)
  await putScratch(ctx, 'annotations', annotations)
  // 终值校准(失败块无检查点不计入;并发期间与 arcs 分支的槽位写可能互相覆盖,此处收敛)
  await bumpAnnotateProgress(ctx, chunkCount)
  return { groups: annotations.length, warnings }
}

/** 汇总各提取单元的角色数据(name+status+plot),供 v2 段角色文件「状态/剧情」取用(§6.1:提取阶段直接产出) */
async function loadUnitStatuses(ctx: WorldGenCtx, totalUnits: number): Promise<(ChapterExtractStatuses | null)[]> {
  const out: (ChapterExtractStatuses | null)[] = new Array(totalUnits).fill(null)
  const rows = await ctx.db.select({ unitIndex: worldGenUnits.unitIndex, result: worldGenUnits.result })
    .from(worldGenUnits)
    .where(eq(worldGenUnits.taskId, ctx.taskId))
    .all()
  for (const r of rows) {
    if (r.unitIndex < 0 || r.unitIndex >= totalUnits) continue
    try {
      const ex = JSON.parse(r.result) as ChapterExtraction
      out[r.unitIndex] = { characters: (ex.characters ?? []).map(c => ({ name: c.name ?? '', status: c.status ?? null, plot: c.plot ?? null })) }
    } catch {
      // 单元结果损坏:该段无状态可用(段角色文件空壳不落盘)
    }
  }
  return out
}

/** 步骤 7:结算成功后写 R2 公共缓存 + world_cache 入库(保留首条)+ 任务完成 + 清 key + 清 scratch。
 *  结算(settleTaskOnSuccess)必须先于写缓存:余额不足转 paused 时,结果与共享缓存均不落,充值补扣后才生效。
 *  postWarnings:并行收尾分支(arcs/annotate)的降级告警,由调用方经 step 返回值透传(Workflows 重放安全),
 *  与 merge 告警聚合写入 warnings 列。 */
export async function stepFinalize(ctx: WorldGenCtx, postWarnings: string[] = []): Promise<{ resultKey: string, cacheId: string | null }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  // 幂等:已完成直接返回(结算成功后才置 completed;重跑/续跑不重复落盘)
  if (task.status === 'completed') return { resultKey: task.resultKey ?? '', cacheId: null }
  const merged = await getScratch<MergedState>(ctx, 'merged')
  const overlay = await getScratch<WorldOverlay>(ctx, 'overlay')
  if (!merged || !overlay) throw new Error('成书中间产物缺失,无法落盘')
  const fresh = await requireTask(ctx)

  const mode: WorldGenMode = task.mode === 'eco' ? 'eco' : task.mode === 'custom' ? 'custom' : 'full'
  // v2 单轨:产物只有 aisb-book zip(剧情段正典/角色/引擎派生数据随包);resultKey 与 worldCache.worldKey 均指向它,
  // 下载/分享/预置消费方现场转换(v2ToWork),旧任务遗留的 v1 json 由下载端点回退兼容。
  const resultKey = book2CacheObjectKey(task.sourceHash, mode)
  const characterArcs = await getScratch<CharacterArc[]>(ctx, 'arcs') ?? []
  const tokensUsed = Math.max(0, fresh.tokensUsed)
  const title = overlay.title || task.title || '未命名'

  // 先结算:余额不足转 paused(已完成待结算),不写 R2/缓存/不置 completed,由 resume 补扣后重跑至此
  const settled = await settleTaskOnSuccess(ctx)
  if (!settled) return { resultKey: '', cacheId: null }

  // v2 打包(§6.2):成书卡(代码翻译为中文保留键)+ 剧情段正典(标转折分组/节点/段角色文件状态)
  //  + 引擎派生数据随包(world.json:entities/conflicts/characterArcs)→ BookDoc zip
  try {
    const annotations = await getScratch<SegmentAnnotation[]>(ctx, 'annotations') ?? []
    const { units: extractUnits, text: fulltext } = await deriveUnits(ctx, task)
    const extracts = await loadUnitStatuses(ctx, extractUnits.length)
    // 弧线坐标系统一(§11.1):arcs 按粗段细纲生成(与 annotate 并行),游玩端按剧情段消费,
    // 落盘前用与 buildBookDoc 相同的分组把 beatIndex 换算到剧情段序(同段合并,每段至多一条)
    const groups = groupBeats(merged.storyline, annotations)
    const doc = buildBookDoc({
      title,
      author: task.author,
      fulltext,
      storyline: merged.storyline,
      extracts,
      overlay,
      annotations,
      world: { entities: merged.entities, conflicts: merged.conflicts, characterArcs: remapArcsToSegments(characterArcs, groups) }
    })
    await ctx.bucket.put(resultKey, bookDocToZip(doc))
  } catch (e) {
    // v2 打包失败 = 任务失败(单轨后没有 v1 兜底产物):保留 scratch,可续跑重试
    console.error('[world-gen] v2 打包失败', { taskId: ctx.taskId }, e)
    throw new Error(`作品格式 v2 打包失败:${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }

  // 缓存入库:同一 (hash, mode) 更新为最新成书(用户选择重新生成时按预期刷新缓存与消耗记录)。
  // 自定义模式不参与共享缓存(开关组合与 full/eco 缓存桶不等价),跳过入库,但成书 R2 文件仍保留供本任务下载。
  let cacheId: string | null = null
  if (task.mode !== 'custom') {
    cacheId = uuid()
    await ctx.db.insert(worldCache).values({
      id: cacheId,
      sourceHash: task.sourceHash,
      mode,
      fileSize: task.fileSize,
      title,
      author: task.author ?? null,
      worldKey: resultKey,
      tokensUsed,
      createdBy: task.userId,
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoUpdate({
      target: [worldCache.sourceHash, worldCache.mode],
      set: {
        worldKey: resultKey,
        tokensUsed,
        title,
        author: task.author ?? null,
        fileSize: task.fileSize,
        updatedAt: new Date()
      }
    }).run()
  }

  await markTask(ctx, {
    status: 'completed',
    stage: 'done',
    resultKey,
    warnings: JSON.stringify([...merged.warnings, ...postWarnings].slice(0, 20))
  })
  await clearTaskKey(ctx)
  await cleanupScratch(ctx)
  // 自定义模式不参与共享缓存,直接返回 null(返回值当前无消费方;冲突时 cacheId 非库内 id,无影响)
  return { resultKey, cacheId: task.mode !== 'custom' ? cacheId : null }
}

// ---- inline 兜底执行(本地 dev 无 Workflow binding 时,waitUntil 内顺序跑同一套步骤) ----

async function pool<T>(items: number[], limit: number, fn: (item: number, index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

/** dev 兜底:按序执行全部步骤(提取并发 4);终态失败统一 markTaskFailed */
export async function runWorldGenPipelineInline(ctx: WorldGenCtx): Promise<void> {
  try {
    const task = await requireTask(ctx)
    await assertNotCancelled(task)
    await markTask(ctx, { status: 'running', stage: task.kind === 'arcs' ? 'arcs' : 'parse' })
    // arcs 任务:只跑补充配角故事线步骤
    if (task.kind === 'arcs') {
      await stepSupplementArcs(ctx)
      return
    }
    const { parsed, plan } = await stepParseAndPlan(ctx)
    // author 识别(开关开启且正则未命中时)与第一批提取并行,后续批次照旧
    const firstBatch = plan.units.map((_, i) => i).slice(0, EXTRACT_CONCURRENCY)
    await Promise.all([
      ...(parsed.author || !stepEnabled(task, 'author') ? [] : [stepAuthorAi(ctx)]),
      ...firstBatch.map(i => extractUnitAt(ctx, plan, i))
    ])
    await pool(plan.units.map((_, i) => i).slice(firstBatch.length), EXTRACT_CONCURRENCY, async (i) => {
      await extractUnitAt(ctx, plan, i)
    })
    await stepMerge(ctx, plan)
    await stepDisambiguate(ctx)
    if (stepEnabled(task, 'check')) await stepCheck(ctx)
    // 成书/弧线/标转折只依赖 merge 产物,并行执行(与 Workflow 编排一致);告警聚合交 finalize
    const [, annRes, arcsRes] = await Promise.all([
      stepSynthesize(ctx),
      stepAnnotate(ctx),
      stepEnabled(task, 'arcs')
        ? stepSupplementArcs(ctx)
        : Promise.resolve({ count: 0, warnings: [] as string[] })
    ])
    await stepFinalize(ctx, [...arcsRes.warnings, ...annRes.warnings])
  } catch (e) {
    if (e instanceof WorldGenCancelledError) return
    if (e instanceof InsufficientTokensError) {
      await markTaskPaused(ctx, e.message).catch(() => {})
      return
    }
    console.error('[world-gen] inline 管线失败', { taskId: ctx.taskId }, e)
    await markTaskFailed(ctx, e instanceof Error ? e.message : String(e)).catch(() => {})
  }
}
