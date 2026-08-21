// server/api/novels/index.post.ts
// 上传小说:TXT → 解析(编码/清洗/切章)→ 入库章节(D1)→ 以正文为上下文交给 LLM 流式生成世界观速览 + 详细人物卡
// 响应为 SSE(text/event-stream):progress/token 实时推送,world+done 收尾,error 失败。
// (不保存原始文件,按要求直接把内容作为上下文传给 AI)
import { parseNovelBytes } from '../../utils/novel-parser'
import { createNovel, insertChapters, updateNovel } from '../../utils/db'
import { streamChat, consumeChatStream, structuredOutput, extractJson } from '../../utils/ai'
import { uuid } from '../../../shared/novel'
import type { ChapterSegment, WorldOverlay, TokenUsage, UploadSseEvent } from '../../../shared/novel'

/** 作为 AI 上下文的正文上限(字符)。超出则取开头,保证单次请求体积可控。 */
const AI_CONTEXT_CHAR_LIMIT = 60000

/**
 * 单次生成的最大输出 token。取 DeepSeek API 允许的上限(实测 max_tokens 合法范围 [1, 393216],
 * 更大如 1000000 会被拒绝)。仅为上限,模型不会真生成这么多,实际消耗以 response usage 为准。
 */
const GENERATION_MAX_TOKENS = 393216

/** 生成世界观 + 人物卡的输出 schema 说明(规划 §5.1 Characters / §6 Character Card) */
const WORLD_SCHEMA_HINT = `{
  "title": "小说标题(string)",
  "genre": "题材/类型(string)",
  "summary": "一两句话简介(string)",
  "characters": [{
    "name": "角色名(string)",
    "role": "主角/配角/反派(string)",
    "alias": "别名,无则 null(string|null)",
    "gender": "性别,如 男/女/未知(string|null)",
    "age": "年龄,如 约40岁/未知(string|null)",
    "identity": "身份职业,如 警察(string|null)",
    "appearance": "外貌特征描写(string|null)",
    "personality": ["性格特征(string)"],
    "speech_style": ["说话风格(string)"],
    "background": "背景故事(string|null)",
    "abilities": ["能力/特殊技能(string)"],
    "goals": ["目标/动机(string)"],
    "fears": ["恐惧/弱点(string)"],
    "secrets": ["秘密(string)"],
    "relationships": [{"name":"对方姓名","type":"关系类型","value":"亲密度,整数 -100~100"}],
    "first_appearance": "首次出现章节,如 第一章(string|null)",
    "dead": "是否已死亡(boolean|null)",
    "patience": "耐心程度,整数 0~100(null 或数值,越小越急躁)",
    "softness": "心软程度,整数 0~100(null 或数值,越大越容易心软)"
  }]
}`

/** 把解析出的章节拼成给 LLM 的上下文(带章节标题,前 N 章优先) */
function buildAIContext(title: string, chapters: ChapterSegment[]): string {
  let out = `《${title}》\n`
  let used = out.length
  for (const ch of chapters) {
    const block = `\n【${ch.title || `第${chapters.indexOf(ch) + 1}部分`}】\n${ch.content}\n`
    if (used + block.length > AI_CONTEXT_CHAR_LIMIT) {
      // 剩余空间还能塞点则截断,否则停
      const remain = AI_CONTEXT_CHAR_LIMIT - used
      if (remain > 80) out += block.slice(0, remain)
      break
    }
    out += block
    used += block.length
  }
  return out
}

/** 粗略的 token 估算(CJK 混排按 字符数/1.7),仅用于实时计数,结束时以模型返回 usage 为准 */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 1.7))
}

export default defineEventHandler(async (event) => {
  const form = await readMultipartFormData(event)
  if (!form || form.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No file uploaded' })
  }

  const file = form.find((f) => f.name === 'file') ?? form[0]
  if (!file || !file.data) {
    throw createError({ statusCode: 400, statusMessage: 'No file data' })
  }

  const filename = (file.filename || 'novel.txt')
  const bytes = new Uint8Array(file.data)
  const userId = 'anon' // TODO(用户系统 §4.1):接入认证后改为真实 userId

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: UploadSseEvent) => {
        const { type, ...payload } = ev
        try {
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`))
        } catch {
          // 客户端已断开,忽略后续写入
        }
      }
      const fail = async (msg: string) => {
        send({ type: 'error', message: msg })
        controller.close()
      }

      // 1) 解析(编码检测 + 清洗 + 章节切分)
      const result = parseNovelBytes(bytes, filename)
      if (result.chapters.length === 0) {
        return await fail('Empty or unparseable file')
      }

      const novelId = uuid()
      await createNovel(event, {
        id: novelId,
        user_id: userId,
        title: result.title,
        author: null,
        source_format: 'txt',
        encoding: result.encoding,
        status: 'parsing',
        parse_progress: 30
      })
      send({ type: 'progress', stage: 'parse', progress: 30 })

      // 2) 章节入库(D1)
      const chapters = result.chapters.map((c, i) => ({ idx: i, title: c.title, content: c.content }))
      await insertChapters(event, novelId, chapters)
      send({ type: 'progress', stage: 'parse', progress: 45 })

      // 3) 以正文为上下文,让 LLM 流式产出世界观速览 + 详细人物卡
      const context = buildAIContext(result.title, result.chapters)
      const messages: { role: 'user', content: string }[] = [
        { role: 'user', content: `这是小说正文,请分析并提取 5~8 个最关键的角色,按下面的 JSON 结构生成世界观速览与详细人物卡。人物卡要忠实于原文,不要编造原著不存在的信息;不确定的字段填 null 或空数组。\n\n${context}` }
      ]
      const system: { role: 'system', content: string } = {
        role: 'system',
        content: `你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。\n输出结构必须满足:\n${WORLD_SCHEMA_HINT}`
      }

      send({ type: 'progress', stage: 'generate', progress: 55 })
      const startedAt = Date.now()

      // 流式调用(优先开启 include_usage 以在流末尾拿真实用量;服务商不支持则去掉重试)
      // thinking 关闭:避免思考 token 挤占 max_tokens 导致 JSON 截断(见 deepseek-v4-flash reasoning)
      let streamRes: Response
      try {
        streamRes = await streamChat(event, [system, ...messages], {
          json: true,
          maxTokens: GENERATION_MAX_TOKENS,
          temperature: 0.3,
          timeoutMs: 300000,
          streamOptions: { include_usage: true },
          thinking: { type: 'disabled' }
        })
      } catch {
        try {
          streamRes = await streamChat(event, [system, ...messages], {
            json: true,
            maxTokens: GENERATION_MAX_TOKENS,
            temperature: 0.3,
            timeoutMs: 300000,
            thinking: { type: 'disabled' }
          })
        } catch (e: any) {
          await updateNovel(event, novelId, { status: 'failed', error: e?.message ?? String(e) })
          return await fail(`AI 请求失败: ${e?.message ?? e}`)
        }
      }

      // 聚合流式分片,节流推送实时 token 计数
      let buffer = ''
      let realUsage: TokenUsage | undefined
      let lastEmitAt = 0
      const emitToken = (force = false) => {
        const now = Date.now()
        if (!force && now - lastEmitAt < 120) return
        lastEmitAt = now
        const elapsedMs = now - startedAt
        const chars = buffer.length
        const tokens = estimateTokens(chars)
        const speed = elapsedMs > 0 ? Math.round((tokens / elapsedMs) * 1000 * 10) / 10 : 0
        send({ type: 'token', tokens, chars, elapsedMs, speed })
      }

      try {
        await consumeChatStream(streamRes, {
          onDelta: (d) => {
            buffer += d
            emitToken()
          },
          onUsage: (u) => { realUsage = u },
          onDone: () => emitToken(true)
        })
      } catch (e: any) {
        await updateNovel(event, novelId, { status: 'failed', error: e?.message ?? String(e) })
        return await fail(`AI 流式输出中断: ${e?.message ?? e}`)
      }

      // 4) 解析 JSON;失败则兜底一次非流式 structuredOutput(可重试并拿到真实 usage)
      let world = extractJson<WorldOverlay>(buffer)
      if (!world) {
        try {
          world = await structuredOutput<WorldOverlay>(event, messages, {
            schemaHint: WORLD_SCHEMA_HINT,
            maxTokens: GENERATION_MAX_TOKENS,
            timeoutMs: 300000,
            maxRetries: 1,
            thinking: { type: 'disabled' }
          })
        } catch (e: any) {
          await updateNovel(event, novelId, { status: 'failed', error: e?.message ?? String(e) })
          return await fail(`AI 输出解析失败: ${e?.message ?? e}`)
        }
      }

      const elapsedMs = Date.now() - startedAt
      const usage: TokenUsage = realUsage ?? { totalTokens: estimateTokens(buffer.length) }
      const title = (world.title || result.title)
      await updateNovel(event, novelId, {
        title,
        chapter_count: chapters.length,
        status: 'ready',
        parse_progress: 100,
        world_state: JSON.stringify(world)
      })

      send({ type: 'progress', stage: 'done', progress: 100 })
      send({ type: 'world', world })
      send({
        type: 'done',
        id: novelId,
        title,
        encoding: result.encoding,
        status: 'ready',
        chapter_count: chapters.length,
        usage,
        elapsedMs
      })
      controller.close()
    }
  })

  return stream
})
