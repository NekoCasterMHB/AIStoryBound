// server/utils/world-gen-pipeline.ts
// 云端世界生成管线:txt 已在 R2,按「解析 → 作者 → 切段提取 → 合并校验 → 检查 → 成书 → 落盘」执行。
// 与浏览器端 generateWorld / 预生成脚本共用 shared/world-build.ts 纯函数,保证产物一致。
//
// 结构约定:
//  - 每个步骤函数幂等(重跑不产生副作用错误),进度与状态实时写 world_gen_tasks 行;
//  - 中间态(合并结果/成书 overlay)写 R2 scratch 前缀,避免塞进 Workflow step 状态或 D1;
//  - 提取单元结果落 world_gen_units 表:断点续跑与 Workflow step 重放时直接跳过已完成单元;
//  - 计费:平台模式创建时预授权(estimated_tokens),管线只累计实耗(tokens_used + ai_usage),
//    终态(完成/失败/取消)按 estimated - used 多退少补(settleTaskBilling,幂等);
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
  ChapterExtraction, CharacterArc, EntityConflict, StoryBeat, TokenUsage, WorldEntities, WorldOverlay
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
import { billedTokens } from '../../shared/token-estimate'
import { parseNovelBytes } from './novel-parser'

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

/** 成书 world json 的公开缓存 key */
export function worldCacheObjectKey(hash: string, mode: string): string {
  return `world-cache/${hash}-${mode}.json`
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
    relayPromise: null as Promise<RelayTarget> | null
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

/** 平台模式逐笔扣费余额不足:任务转入 paused(充值后可续跑),消息直接展示给用户 */
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
      return { doneUnits: d.doneUnits ?? 0, totalUnits: d.totalUnits ?? 0, plan: d.plan }
    }
  } catch {
    // 损坏按空处理
  }
  return { doneUnits: 0, totalUnits: 0 }
}

// ---- 计费与账目 ----

/**
 * 累计实耗:平台新计费(reserveTaken=0)先逐笔原子扣余额(不足抛 InsufficientTokensError),
 * 再落 ai_usage 账 + tokens_used 增量;旧任务(reserveTaken=1,创建时已预扣)仅记账。
 * 扣费必须先于调用方的结果落库:余额不足时该次调用结果不计入,续跑会重跑该单元并重新扣费。
 */
export async function recordTaskUsage(ctx: TaskRef, task: WorldGenTaskRow, usage: TokenUsage): Promise<void> {
  const tokens = billedTokens(usage)
  if (tokens <= 0) return
  if (task.keySource === 'platform' && task.reserveTaken === 0) {
    const claimed = await ctx.db.update(usersTable)
      .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${tokens}` })
      .where(and(eq(usersTable.id, task.userId), sql`${usersTable.aiTokenBalance} >= ${tokens}`))
      .run()
    if (claimed.meta.changes === 0) {
      throw new InsufficientTokensError()
    }
  }
  try {
    await ctx.db.insert(aiUsage).values({
      id: uuid(),
      userId: task.userId,
      taskId: ctx.taskId,
      tokens,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      createdAt: new Date()
    }).run()
    await ctx.db.update(worldGenTasks)
      .set({ tokensUsed: sql`${worldGenTasks.tokensUsed} + ${tokens}`, updatedAt: new Date() })
      .where(eq(worldGenTasks.id, ctx.taskId))
      .run()
  } catch (e) {
    console.error('[world-gen] 用量记账失败', { taskId: ctx.taskId, tokens }, e)
  }
}

/**
 * 平台旧计费(创建时预扣估算额)终态结算:按 estimated - used 多退少补(封底 0,不追缴)。
 * 幂等:退款后把 estimated_tokens 清零作为标记,重复调用不再退。新计费任务(逐笔实扣)无预扣、直接跳过。
 */
export async function settleTaskBilling(ctx: TaskRef): Promise<void> {
  const task = await requireTask(ctx)
  if (task.keySource !== 'platform') return
  if (task.reserveTaken !== 1) return
  if (task.estimatedTokens <= 0) return
  const refund = Math.max(0, task.estimatedTokens - Math.max(0, task.tokensUsed))
  try {
    if (refund > 0) {
      await ctx.db.update(usersTable)
        .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${refund}` })
        .where(eq(usersTable.id, task.userId))
        .run()
    }
    await ctx.db.update(worldGenTasks)
      .set({ estimatedTokens: 0, updatedAt: new Date() })
      .where(eq(worldGenTasks.id, ctx.taskId))
      .run()
  } catch (e) {
    console.error('[world-gen] 结算失败', { taskId: ctx.taskId, refund }, e)
  }
}

/** 清空自建 key 暂存(任务终态必须调用;防库文件/备份静态泄露) */
export async function clearTaskKey(ctx: TaskRef): Promise<void> {
  await ctx.db.update(worldGenTasks)
    .set({ keyCiphertext: null, keyIv: null, updatedAt: new Date() })
    .where(eq(worldGenTasks.id, ctx.taskId))
    .run()
}

/** 失败终态:置状态 + 结算 + 清 key(Workflow run 顶层 catch 与孤儿清扫共用;仅需 db + taskId) */
export async function markTaskFailed(ctx: TaskRef, message: string): Promise<void> {
  await markTask(ctx, { status: 'failed', error: message.slice(0, 800) })
  await settleTaskBilling(ctx)
  await clearTaskKey(ctx)
}

/** 余额不足终态:任务转 paused(进度/单元明细保留,充值后可续跑);已消耗部分照常扣费,无预扣可退 */
export async function markTaskPaused(ctx: TaskRef, message: string): Promise<void> {
  await markTask(ctx, { status: 'paused', error: message.slice(0, 800) })
  await clearTaskKey(ctx)
}

/**
 * 孤儿任务兜底(状态查询接口周期调用):
 *  - running 超时(STALE_RUNNING_MS)→ 判失败并结算(Workflow 被强杀时的退款兜底);
 *  - 终态仍带 key 暂存 → 清空(强杀残留)。
 */
export async function sweepStaleWorldGenTasks(db: WorldGenDb): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS)
  const now = new Date()
  try {
    // running 超时 → failed(逐行结算;数量极少,不值得批量优化)
    const staleRunning = await db.select({ id: worldGenTasks.id })
      .from(worldGenTasks)
      .where(and(eq(worldGenTasks.status, 'running'), lt(worldGenTasks.updatedAt, staleBefore)))
      .all()
    for (const t of staleRunning) {
      const ref: TaskRef = { db, taskId: t.id }
      await markTask(ref, { status: 'failed', error: '任务超时未完成(执行环境中断),已按实际消耗结算' })
      await settleTaskBilling(ref)
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

/** 从全文确定性重建提取单元(每步骤独立重算:内容不进 Workflow step 状态/D1) */
async function deriveUnits(ctx: WorldGenCtx, task: WorldGenTaskRow): Promise<{ units: ExtractUnit[], text: string }> {
  const text = await fetchSourceText(ctx, task)
  const units = splitUnits([{ title: '', content: text }])
  return { units, text }
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

/** 作者 AI 兜底:正则未识别时,用书名页片段请模型判断(可失败,失败仅视为未识别) */
export async function stepAuthorAi(ctx: WorldGenCtx): Promise<string | null> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  if (task.author) return task.author
  const text = await fetchSourceText(ctx, task)
  const front = extractFrontMatter(text, 3000)
  if (!front.trim()) return null
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
      await markTask(ctx, { author })
      return author
    }
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

/** 提取完成数刷新(stage_detail.doneUnits;必须保留 plan 等既有字段,进度更新会穿插在提取期间) */
async function bumpExtractProgress(ctx: TaskRef, totalUnits: number): Promise<void> {
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
  await markTask(ctx, { stage: task.mode === 'eco' ? 'synthesize' : 'check' })
  return { okUnits, totalUnits: plan.length, characters: entities.characters.length, storyline: storyline.length, warnings }
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
  await markTask(ctx, { stage: 'synthesize' })
  return { warnings }
}

/** 步骤 6:成书(完整=AI 速览+人物卡;节约=轻量概览+本地直拼卡)→ scratch/overlay.json */
export async function stepSynthesize(ctx: WorldGenCtx): Promise<{ cardCount: number, title: string }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  const merged = await getScratch<MergedState>(ctx, 'merged')
  if (!merged) throw new Error('合并结果缺失,无法成书')
  const { entities, conflicts, warnings, localSummary } = merged
  const title = task.title || '小说'
  const relay = await relayOf(ctx, task)
  const eco = task.mode === 'eco'

  let overlay: WorldOverlay
  if (eco) {
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
  await markTask(ctx, { stage: 'done' })
  return { cardCount: (overlay.characters ?? []).length, title: overlay.title || title }
}

// ---- 配角故事线生成(arcs 补充任务 + world 成书共用,逐单元) ----

/** arcs 任务输入载荷(world_gen_tasks.payload JSON):客户端上传该作品实体库、主线细纲与全书正文 */
interface ArcsTaskPayload {
  entities: WorldEntities
  storyline: StoryBeat[]
  /** 全书正文(chapters.join('\n');用于登场段原文窗口,缺失时跳过注入) */
  text?: string
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
 *  - 每单元一次 AI 调用,成功即原子扣费(余额不足抛 InsufficientTokensError → paused);
 *  - 单单元失败(非余额)降级跳过并记 warning;全部失败 → 抛错判 failed;至少 1 条成功 → 完成;
 *  - 结果写 scratch arcs.json(world 任务由 finalize 落盘成书,arcs 任务由 /tasks/[id]/arcs 读取);
 *  - 每单元注入该角色前几个登场段的原文节选,模型据此还原细节(忠实度接近按原文提取)。
 */
export async function stepSupplementArcs(ctx: WorldGenCtx): Promise<{ count: number }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)

  // ---- 数据来源:arcs 任务用 payload;world 成书用 merged + R2 原文 ----
  let entities: WorldEntities
  let storyline: StoryBeat[]
  let sourceText: string | null
  if (task.kind === 'arcs') {
    const payload = parseArcsPayload(task.payload)
    if (!payload) throw new Error('任务载荷缺失,无法生成配角故事线')
    entities = payload.entities
    storyline = payload.storyline
    sourceText = payload.text ?? null
  } else {
    const merged = await getScratch<MergedState>(ctx, 'merged')
    if (!merged) throw new Error('合并结果缺失,无法生成配角故事线')
    entities = merged.entities
    storyline = merged.storyline
    if (!storyline || storyline.length === 0) return { count: 0 }
    sourceText = (await deriveUnits(ctx, task)).text
  }

  const candidates = characterArcCandidates(entities, storyline)
  const totalUnits = candidates.length
  if (totalUnits === 0) {
    // 无候选角色:arcs 任务直接完成(空结果);world 成书静默跳过(由 finalize 落盘)
    if (task.kind === 'arcs') {
      await putScratch(ctx, 'arcs', [])
      await markTask(ctx, { status: 'completed', stage: 'done', warnings: '[]' })
    }
    return { count: 0 }
  }

  const title = task.title || '未命名小说'
  await markTask(ctx, { stage: 'arcs', stageDetail: JSON.stringify({ doneUnits: 0, totalUnits }) })

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
  // 未完成单元不做持久化检查点:重跑会重跑全部单元并重新扣费,与「续跑重跑并重扣费」语义一致。
  await pool(candidates.map((_, i) => i), EXTRACT_CONCURRENCY, async (i) => {
    const candidate = candidates[i]!
    try {
      // 不设 maxTokens:输出上限交给上游模型自身,避免登场段多时被低上限截断丢段
      const { data, usage } = await callAiJson(relay, {
        messages: buildCharacterArcMessages(title, candidate, storyline, textWindowOf(candidate)),
        temperature: 0.3
      })
      // 先扣费再落结果:余额不足抛出时该条结果不计入,续跑重跑并重新扣费,不漏账
      await recordTaskUsage(ctx, task, usage)
      const normalized = normalizeCharacterArcs(data, storyline, entities.characters)
      if (normalized.length > 0) arcs.push(normalized[0]!)
    } catch (e) {
      if (e instanceof InsufficientTokensError) throw e
      warnings.push(`「${candidate.card.name}」故事线生成失败:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  if (arcs.length === 0) {
    // arcs 补充任务:全部失败 → 判失败;world 成书:降级跳过(不影响成书落盘)
    if (task.kind === 'arcs') throw new Error(warnings[0] ?? '所有角色的故事线均生成失败')
    await markTask(ctx, { stage: 'done', warnings: JSON.stringify(warnings.slice(0, 20)) })
    return { count: 0 }
  }
  await putScratch(ctx, 'arcs', arcs)
  const done: Partial<typeof worldGenTasks.$inferInsert> = {
    stage: 'done',
    stageDetail: JSON.stringify({ doneUnits: totalUnits, totalUnits }),
    warnings: JSON.stringify(warnings.slice(0, 20))
  }
  // arcs 任务在此完成;world 任务保持 running,由 finalize 落盘并置完成
  if (task.kind === 'arcs') done.status = 'completed'
  await markTask(ctx, done)
  return { count: arcs.length }
}

export interface WorldJsonPayload {
  id: string
  title: string
  author: string | null
  genre: string | null
  summary: string | null
  characters: unknown[]
  overlay: WorldOverlay
  storyline: StoryBeat[]
  characterArcs: CharacterArc[]
  entities: WorldEntities
  conflicts: EntityConflict[]
  warnings: string[]
  tokensUsed: number
  mode: WorldGenMode
  generatedAt: string
  version: 2
}

/** 步骤 7:world json 写 R2 公共缓存 + world_cache 入库(保留首条)+ 任务完成 + 结算 + 清 key + 清 scratch */
export async function stepFinalize(ctx: WorldGenCtx): Promise<{ resultKey: string, cacheId: string | null }> {
  const task = await requireTask(ctx)
  await assertNotCancelled(task)
  const merged = await getScratch<MergedState>(ctx, 'merged')
  const overlay = await getScratch<WorldOverlay>(ctx, 'overlay')
  if (!merged || !overlay) throw new Error('成书中间产物缺失,无法落盘')
  const fresh = await requireTask(ctx)

  const mode: WorldGenMode = task.mode === 'eco' ? 'eco' : 'full'
  const resultKey = worldCacheObjectKey(task.sourceHash, mode)
  const characterArcs = await getScratch<CharacterArc[]>(ctx, 'arcs') ?? []
  const payload: WorldJsonPayload = {
    id: task.sourceHash,
    title: overlay.title || task.title || '未命名',
    author: task.author ?? null,
    genre: null,
    summary: overlay.summary ?? null,
    characters: overlay.characters ?? [],
    overlay,
    storyline: merged.storyline,
    characterArcs,
    entities: merged.entities,
    conflicts: merged.conflicts,
    warnings: merged.warnings,
    tokensUsed: Math.max(0, fresh.tokensUsed),
    mode,
    generatedAt: new Date().toISOString(),
    version: 2
  }
  await ctx.bucket.put(resultKey, JSON.stringify(payload))

  // 缓存入库:同一 (hash, mode) 更新为最新成书(用户选择重新生成时按预期刷新缓存与消耗记录)
  const cacheId = uuid()
  await ctx.db.insert(worldCache).values({
    id: cacheId,
    sourceHash: task.sourceHash,
    mode,
    fileSize: task.fileSize,
    title: payload.title,
    author: task.author ?? null,
    worldKey: resultKey,
    tokensUsed: payload.tokensUsed,
    createdBy: task.userId,
    createdAt: new Date(),
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: [worldCache.sourceHash, worldCache.mode],
    set: {
      worldKey: resultKey,
      tokensUsed: payload.tokensUsed,
      title: payload.title,
      author: task.author ?? null,
      fileSize: task.fileSize,
      updatedAt: new Date()
    }
  }).run()

  await markTask(ctx, {
    status: 'completed',
    stage: 'done',
    resultKey,
    warnings: JSON.stringify(merged.warnings.slice(0, 20))
  })
  await settleTaskBilling(ctx)
  await clearTaskKey(ctx)
  await cleanupScratch(ctx)
  const hit = await ctx.db.select({ id: worldCache.id }).from(worldCache)
    .where(and(eq(worldCache.sourceHash, task.sourceHash), eq(worldCache.mode, mode))).get()
  return { resultKey, cacheId: hit?.id ?? cacheId }
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
    // author 识别(正则未命中时)与第一批提取并行,后续批次照旧
    const firstBatch = plan.units.map((_, i) => i).slice(0, EXTRACT_CONCURRENCY)
    await Promise.all([
      ...(parsed.author ? [] : [stepAuthorAi(ctx)]),
      ...firstBatch.map(i => extractUnitAt(ctx, plan, i))
    ])
    await pool(plan.units.map((_, i) => i).slice(firstBatch.length), EXTRACT_CONCURRENCY, async (i) => {
      await extractUnitAt(ctx, plan, i)
    })
    await stepMerge(ctx, plan)
    if (task.mode !== 'eco') await stepCheck(ctx)
    await stepSynthesize(ctx)
    if (task.mode !== 'eco') await stepSupplementArcs(ctx)
    await stepFinalize(ctx)
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
