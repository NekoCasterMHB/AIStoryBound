// server/api/ai/chat.post.ts
// 通用 AI 中继(无状态,浏览器编排的单一 AI 入口):登录后携带消息体进来,服务器负责
//  - 请求体带 config(用户浏览器本地保存的 baseUrl/apiKey/model)→ 用用户 key 转发、不扣平台配额、不落库
//  - 未带 config → 用平台密钥转发,并按流尾 usage 扣减 ai_token_balance(余额≤0 前置拦截 402)
// 自建配置支持三种 API 格式(chat/anthropic/responses),上游流统一翻译成 OpenAI 兼容 SSE
// 透传给前端(含流尾 usage 分片);前端自行解析 delta 与 usage。
// 模型选择不信任请求体:平台模式用 env AI_MODEL;用户模式模型取自请求 config(用用户自己的 key,选什么模型都由用户自己付费)。
import { eq, sql } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { getAiConfig } from '../../utils/ai'
import { buildUpstreamRequest, relaySse } from '../../utils/ai-relay'
import { isAiApiFormat } from '../../../shared/ai-config'
import { RELAY_TIMEOUT_DEFAULT_MS, RELAY_TIMEOUT_MIN_MS, RELAY_TIMEOUT_MAX_MS } from '../../../shared/ai-config'
import { user as usersTable, aiUsage } from '../../db/schema'
import { uuid } from '../../../shared/novel'

/** 请求体可携带单次调用超时(毫秒),由个人中心生成参数下发;缺失/越界用默认值,上限防止拖住上游连接 */
function clampRelayTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  if (Number.isNaN(n)) return RELAY_TIMEOUT_DEFAULT_MS
  return Math.min(RELAY_TIMEOUT_MAX_MS, Math.max(RELAY_TIMEOUT_MIN_MS, n))
}

interface ChatRelayBody {
  messages?: { role: 'system' | 'user' | 'assistant', content: string }[]
  json?: boolean
  maxTokens?: number
  temperature?: number
  thinking?: boolean
  /** 单次调用超时(毫秒);缺省用平台默认 600s */
  timeoutMs?: number
  /** 用户浏览器本地保存的自建配置,仅本次请求使用、不落库 */
  config?: { format?: string, baseUrl?: string, apiKey?: string, model?: string }
}

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const body = await readBody<ChatRelayBody>(event).catch(() => ({} as ChatRelayBody))
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'messages 必须是非空数组' })
  }

  const db = useD1(event)
  const row = await db.select().from(usersTable).where(eq(usersTable.id, sessUser.id)).get()

  // ---- 选用转发配置:请求体携带的用户自建 key 优先 ----
  let relay: RelayTarget & { userKey: boolean }
  const cfg = body.config
  if (cfg?.baseUrl && cfg?.apiKey) {
    if (!isAiApiFormat(cfg.format)) {
      throw createError({ statusCode: 400, statusMessage: 'API 格式无效' })
    }
    relay = {
      format: cfg.format,
      baseUrl: String(cfg.baseUrl),
      apiKey: String(cfg.apiKey),
      model: String(cfg.model || 'default'),
      userKey: true
    }
  } else {
    const ai = getAiConfig(event)
    if (!ai.apiKey) {
      throw createError({ statusCode: 500, statusMessage: '平台 AI 未配置(缺少 AI_API_KEY)' })
    }
    const balance = row?.aiTokenBalance ?? 0
    if (balance <= 0) {
      throw createError({
        statusCode: 402,
        statusMessage: 'token 余额不足,请到个人中心购买加油包或配置自己的 API Key'
      })
    }
    relay = { format: 'chat', baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, userKey: false }
  }

  // ---- 按格式构建上游请求并转发 ----
  const req = buildUpstreamRequest(relay, {
    messages,
    json: body.json,
    maxTokens: body.maxTokens,
    temperature: body.temperature,
    thinking: body.thinking,
    stream: true
  })

  let upstream: Response
  try {
    upstream = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(clampRelayTimeout(body.timeoutMs))
    })
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: `AI 上游请求失败: ${(e as Error).message}` })
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    throw createError({
      statusCode: 502,
      statusMessage: `AI 上游错误 (${upstream.status}): ${detail.slice(0, 300)}`
    })
  }

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  })

  const { sse, usage } = await relaySse(relay, upstream)

  // 平台模式:按真实用量扣减(允许并发下轻微超卖;负值由前置余额检查兜底)
  if (!relay.userKey) {
    void usage.then((u) => {
      const cost = u?.totalTokens ?? 0
      if (cost > 0) {
        void db.update(usersTable)
          .set({ aiTokenBalance: sql`MAX(${usersTable.aiTokenBalance} - ${cost}, 0)` })
          .where(eq(usersTable.id, sessUser.id))
          .run()
          .catch(() => {})
        // 用量落库:管理仪表盘近 24h 消耗统计与金额估算(历史数据自部署后累计)
        void db.insert(aiUsage).values({
          id: uuid(),
          userId: sessUser.id,
          tokens: cost,
          promptTokens: u?.promptTokens ?? 0,
          completionTokens: u?.completionTokens ?? 0,
          createdAt: new Date()
        }).run().catch(() => {})
      }
    })
  }

  return new Response(sse)
})
