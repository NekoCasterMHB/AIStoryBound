// server/api/tts.post.ts
// 语音合成中转:登录用户 → 独立部署的 Edge TTS Worker(OpenAI 兼容 /v1/audio/speech)。
// API Key 只存服务端(env.TTS_API_KEY 机密 / runtimeConfig 兜底),绝不落前端;
// 入参白名单化(input/voice/speed/pitch),防把本端点当任意参数的上游代理用。
// 计费:按估算音频时长(秒)计 token——1 秒 = 10 token,时长 = 字符数 ÷(基准语速 × 语速参数),
// 见 shared/tts.ts estimateTtsTokens。转发前原子条件预扣(余额不足 402),上游失败退还;
// 成功即消耗(TTS 成本由输入长度与语速决定,输出确定,无流尾结算)。
// 成功后落 ai_usage(token 消耗统计),金额估算不参与(prompt/completion 置 0,非 LLM 成本)。
import { and, eq, sql } from 'drizzle-orm'
import { useD1 } from '../utils/d1'
import { requireUser } from '../utils/authz'
import { user as usersTable, aiUsage } from '../db/schema'
import { TTS_MAX_INPUT_CHARS, estimateTtsTokens, isTtsVoice } from '../../shared/tts'
import { uuid } from '../../shared/novel'

interface TtsBody {
  input?: unknown
  voice?: unknown
  speed?: unknown
  pitch?: unknown
}

/** 数值参数钳制:非有限数返回 undefined(用上游默认值) */
function clampNum(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : NaN
  if (Number.isNaN(n)) return undefined
  return Math.min(max, Math.max(min, n))
}

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)

  const body = await readBody<TtsBody>(event).catch(() => ({} as TtsBody))
  const input = typeof body.input === 'string' ? body.input.trim() : ''
  if (!input) {
    throw createError({ statusCode: 400, statusMessage: 'input 必填' })
  }
  if (input.length > TTS_MAX_INPUT_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `文本过长(上限 ${TTS_MAX_INPUT_CHARS} 字符)` })
  }
  // voice 传了但不在白名单 → 400(而不是静默替换,避免调用方拿到与预期不符的音色还以为已生效)
  if (body.voice !== undefined && !isTtsVoice(body.voice)) {
    throw createError({ statusCode: 400, statusMessage: 'voice 不是可用的音色名' })
  }
  const speed = clampNum(body.speed, 0.25, 2)
  const pitch = clampNum(body.pitch, 0.25, 2)

  // 配置:Cloudflare binding env 优先(wrangler.toml [vars] TTS_BASE_URL + secret TTS_API_KEY),
  // runtimeConfig(NUXT_TTS_BASE_URL / NUXT_TTS_API_KEY)兜底
  const env = (event.context as { cloudflare?: { env?: Record<string, string | undefined> } | undefined }).cloudflare?.env
  const rt = useRuntimeConfig(event).tts as { baseUrl?: string, apiKey?: string } | undefined
  const baseUrl = (env?.TTS_BASE_URL || rt?.baseUrl || '').replace(/\/+$/, '')
  const apiKey = env?.TTS_API_KEY || rt?.apiKey || ''
  if (!baseUrl || !apiKey) {
    throw createError({ statusCode: 503, statusMessage: '语音服务未配置,请联系管理员' })
  }

  // ---- 预扣:按估算音频时长计 token(1 秒 = 1 token),原子条件扣减(余额足够才扣,失败 402) ----
  const cost = estimateTtsTokens(input, speed ?? 1)
  const db = useD1(event)
  const claimed = await db.update(usersTable)
    .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} - ${cost}` })
    .where(and(eq(usersTable.id, sessUser.id), sql`${usersTable.aiTokenBalance} >= ${cost}`))
    .run()
  if (claimed.meta.changes === 0) {
    throw createError({ statusCode: 402, statusMessage: 'token 余额不足,无法合成语音,请到个人中心购买加油包' })
  }

  // 预扣后的退还:上游请求阶段任何失败(连接失败/非 2xx)先退预扣再抛错,不让用户凭空损失
  const refund = async () => {
    try {
      await db.update(usersTable)
        .set({ aiTokenBalance: sql`${usersTable.aiTokenBalance} + ${cost}` })
        .where(eq(usersTable.id, sessUser.id))
        .run()
    } catch (e) {
      console.error('[tts] 预扣退还失败', { userId: sessUser.id, cost }, e)
    }
  }

  let upstream: Response
  try {
    upstream = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1',
        input,
        ...(body.voice !== undefined ? { voice: body.voice } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(pitch !== undefined ? { pitch } : {})
      }),
      signal: AbortSignal.timeout(180_000)
    })
  } catch (e) {
    await refund()
    throw createError({ statusCode: 502, statusMessage: `语音上游请求失败: ${(e as Error).message}` })
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    await refund()
    throw createError({ statusCode: 502, statusMessage: `语音上游错误 (${upstream.status}): ${detail.slice(0, 200)}` })
  }
  if (!upstream.body) {
    await refund()
    throw createError({ statusCode: 502, statusMessage: '语音上游未返回音频内容' })
  }

  // 落账:token 消耗统计(成功即消耗;prompt/completion 置 0,TTS 非 LLM 成本不进金额估算)
  event.waitUntil((async () => {
    try {
      await db.insert(aiUsage).values({
        id: uuid(),
        userId: sessUser.id,
        tokens: cost,
        createdAt: new Date()
      }).run()
    } catch (e) {
      console.error('[tts] 用量落库失败', { userId: sessUser.id, cost }, e)
    }
  })())

  setResponseHeaders(event, {
    'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
    'Cache-Control': 'no-store',
    'X-TTS-Tokens-Billed': String(cost)
  })
  return upstream.body
})
