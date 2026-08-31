// server/api/ai/chat.post.ts
// 通用 AI 中继(无状态,浏览器编排的单一 AI 入口):登录后携带消息体进来,服务器负责
//  - 请求体带 config(用户浏览器本地保存的 baseUrl/apiKey/model)→ 用用户 key 转发、不扣平台配额、不落库。
//    准入双重门槛:格式约束(https + 长度)+ 验证指纹(个人中心测试通过后服务端留痕,
//    见 server/utils/ai-fingerprint.ts);上游失败直接 502 返回,绝不回退平台 key——用户自建模式
//    对平台 token 的消耗恒为 0,这条结构保证不依赖任何运行时判断。
//  - 未带 config → 用平台密钥转发。计费为「预授权 + 流尾多退少补」:转发前按 输入估算 + 输出预留
//    原子预扣余额(余额不足直接 402),流尾按真实 usage 结算(多退少补,封底 0)。
//    关闭两个平台 token 流失洞:① 余额 1 也能跑满全程后封底扣费、无限重复(每次都实付差额);
//    ② 余额检查与流尾扣费之间隔着整个流式请求,并发请求全部通过前置检查(超卖)。
//    预扣随每次调用结束即释放,世界生成并发 4 单元的在途预留远低于注册赠送额度,正常体验不受影响。
//    waitUntil 兜底 isolate 冻结:极端情况下预扣未结算则用户多扣(损失方向为用户),平台不吃亏。
// 自建配置支持三种 API 格式(chat/anthropic/responses),上游流统一翻译成 OpenAI 兼容 SSE
// 透传给前端(含流尾 usage 分片);前端自行解析 delta 与 usage。
// 模型选择不信任请求体:平台模式用后台配置(ai_provider_configs,未配置回退 env AI_MODEL);用户模式模型取自请求 config(用用户自己的 key,选什么模型都由用户自己付费)。
// 用途路由:请求体 purpose('worldGen'|'chat',缺省 chat)只决定使用管理员配置的哪一条配置行(getAiConfig 第二参),不能指定任意模型。
import { and, eq, sql } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { getAiConfig } from '../../utils/ai'
import { buildUpstreamRequest, relaySse, maskApiKey } from '../../utils/ai-relay'
import { isAiApiFormat, RELAY_TIMEOUT_DEFAULT_MS, RELAY_TIMEOUT_MIN_MS, RELAY_TIMEOUT_MAX_MS } from '../../../shared/ai-config'
import { aiConfigFingerprint } from '../../utils/ai-fingerprint'
import { billedTokens, estimateMessagesTokens } from '../../../shared/token-estimate'
import { user as usersTable, aiUsage, aiConfigVerifications } from '../../db/schema'
import { uuid } from '../../../shared/novel'

/** 请求体可携带单次调用超时(毫秒),由个人中心生成参数下发;缺失/越界用默认值,上限防止拖住上游连接 */
function clampRelayTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  if (Number.isNaN(n)) return RELAY_TIMEOUT_DEFAULT_MS
  return Math.min(RELAY_TIMEOUT_MAX_MS, Math.max(RELAY_TIMEOUT_MIN_MS, n))
}

/** maxTokens 服务端钳制(两模式统一):防客户端传天文数字放大单次上游成本与预扣额 */
function clampMaxTokens(v: unknown): number | undefined {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  if (Number.isNaN(n) || n <= 0) return undefined
  return Math.min(32_768, n)
}

/** 客户端未传 maxTokens 时的输出预留(平台模式预扣用);实测调用大多显式传 200~5000 */
const OUTPUT_RESERVE_DEFAULT = 16_384

interface ChatRelayBody {
  messages?: { role: 'system' | 'user' | 'assistant', content: string }[]
  json?: boolean
  maxTokens?: number
  temperature?: number
  /** 思考开关:统一关闭(false);缺省按关闭处理 */
  thinking?: boolean
  /** 单次调用超时(毫秒);缺省用平台默认 600s */
  timeoutMs?: number
  /** 用户浏览器本地保存的自建配置,仅本次请求使用、不落库;必须与最近一次测试连接通过的配置一致(指纹准入) */
  config?: { format?: string, baseUrl?: string, apiKey?: string, model?: string }
  /** 用途路由:'worldGen'=生成世界流水线,'chat'=对话类(缺省);仅平台模式生效,决定用管理员配置的哪条配置行 */
  purpose?: string
}

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const body = await readBody<ChatRelayBody>(event).catch(() => ({} as ChatRelayBody))
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'messages 必须是非空数组' })
  }

  const db = useD1(event)
  const maxTokens = clampMaxTokens(body.maxTokens)
  /** 本次请求平台模式已预扣的 token 数(0 = 用户模式/未预扣) */
  let reserveTokens = 0

  // ---- 选用转发配置:请求体携带的用户自建 key 优先 ----
  let relay: RelayTarget & { userKey: boolean }
  const cfg = body.config
  if (cfg?.baseUrl && cfg?.apiKey) {
    // ---- 用户自建模式:格式约束 + 验证指纹准入 ----
    if (!isAiApiFormat(cfg.format)) {
      throw createError({ statusCode: 400, statusMessage: 'API 格式无效' })
    }
    const baseUrl = String(cfg.baseUrl).trim()
    const apiKey = String(cfg.apiKey).trim()
    const model = String(cfg.model || '').trim()
    if (!/^https:\/\/.+/i.test(baseUrl)) {
      throw createError({ statusCode: 400, statusMessage: 'baseUrl 必须是 https 地址' })
    }
    if (baseUrl.length > 512 || apiKey.length > 256 || !model || model.length > 128) {
      throw createError({ statusCode: 400, statusMessage: '配置格式无效(baseUrl ≤512 / apiKey ≤256 / model 必填 ≤128)' })
    }
    const normalized = { format: cfg.format, baseUrl, apiKey, model }
    const fingerprint = await aiConfigFingerprint(event, sessUser.id, normalized)
    const verified = await db.select({ id: aiConfigVerifications.id })
      .from(aiConfigVerifications)
      .where(and(eq(aiConfigVerifications.userId, sessUser.id), eq(aiConfigVerifications.fingerprint, fingerprint)))
      .get()
    if (!verified) {
      throw createError({ statusCode: 400, statusMessage: '配置未验证或已变更,请到个人中心重新测试后再使用' })
    }
    relay = { ...normalized, userKey: true }
  } else {
    // 用途路由:白名单校验,非 'worldGen' 一律按 'chat',决定使用管理员配置的哪条配置行
    const purpose = body.purpose === 'worldGen' ? 'worldGen' as const : 'chat' as const
    const ai = await getAiConfig(event, purpose)
    if (!ai.apiKey) {
      throw createError({ statusCode: 500, statusMessage: '平台 AI 未配置,请联系管理员在后台配置' })
    }

    // ---- 预授权:输入估算 + 输出预留,原子条件预扣(余额足够才扣,失败 402) ----
    const reserve = estimateMessagesTokens(messages) + (maxTokens ?? OUTPUT_RESERVE_DEFAULT)
    const claimed = await db.update(usersTable)
      .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${reserve}` })
      .where(and(eq(usersTable.id, sessUser.id), sql`${usersTable.aiTokenBalance} >= ${reserve}`))
      .run()
    if (claimed.meta.changes === 0) {
      throw createError({
        statusCode: 402,
        statusMessage: 'token 余额不足以预扣本次调用的预估消耗,请到个人中心购买加油包或配置自己的 API Key'
      })
    }
    reserveTokens = reserve

    relay = { format: ai.format, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, userKey: false }
  }

  // ---- 按格式构建上游请求并转发(思考统一关闭:缺省 false 也显式传,chat 格式会发 thinking:{type:'disabled'}) ----
  const req = buildUpstreamRequest(relay, {
    messages,
    json: body.json,
    maxTokens,
    temperature: body.temperature,
    thinking: body.thinking === true,
    stream: true
  })

  // 平台模式预扣后的回滚:上游请求阶段的任何失败(连接失败/非 2xx)先退还预扣再抛错,不让用户凭空损失
  const refundReserve = async () => {
    if (reserveTokens <= 0) return
    try {
      await db.update(usersTable)
        .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${reserveTokens}` })
        .where(eq(usersTable.id, sessUser.id))
        .run()
    } catch (e) {
      console.error('[ai/chat] 预扣退还失败', { userId: sessUser.id, reserve: reserveTokens }, e)
    }
  }

  let upstream: Response
  try {
    upstream = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(clampRelayTimeout(body.timeoutMs))
    })
  } catch (e) {
    if (!relay.userKey) await refundReserve()
    throw createError({ statusCode: 502, statusMessage: `AI 上游请求失败: ${(e as Error).message}` })
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    if (!relay.userKey) await refundReserve()
    throw createError({
      statusCode: 502,
      statusMessage: `AI 上游错误 (${upstream.status}): ${maskApiKey(detail.slice(0, 300), relay.apiKey)}`
    })
  }

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  })

  const { sse, usage } = await relaySse(relay, upstream, messages)

  // 平台模式:流尾结算——预扣多退少补(封底 0),并按真实用量落 aiUsage。
  // usage 拿不到真实值(玩家中途取消/上游不返回 usage)时,relaySse 已按 shared/token-estimate
  // 口径用已转发的消息与输出内容估算兜底,取消的请求同样如实结算。
  if (!relay.userKey) {
    const reserve = reserveTokens
    event.waitUntil(usage.then(async (u) => {
      const cost = billedTokens(u)
      try {
        await db.update(usersTable)
          .set({ aiTokenBalance: sql`MAX(${usersTable.aiTokenBalance} + ${reserve} - ${cost}, 0)` })
          .where(eq(usersTable.id, sessUser.id))
          .run()
        // 用量落库:管理仪表盘近 24h 消耗统计与金额估算(历史数据自部署后累计)
        if (cost > 0) {
          await db.insert(aiUsage).values({
            id: uuid(),
            userId: sessUser.id,
            tokens: cost,
            promptTokens: u?.promptTokens ?? 0,
            completionTokens: u?.completionTokens ?? 0,
            createdAt: new Date()
          }).run()
        }
      } catch (e) {
        console.error('[ai/chat] 结算失败', { userId: sessUser.id, reserve, cost }, e)
      }
    }))
  }

  return new Response(sse)
})
