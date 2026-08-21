// server/api/games/[id]/turn.post.ts
// 游戏回合(SSE):玩家选择选项/自由输入 → AI 流式生成剧情与对话(打字机)
// → 结构化生成 3 个选项 + 状态变化(轻量引擎按白名单合并,LLM 不直接改库)
import { getNovel } from '../../../utils/db'
import { getGame, updateGame, appendMessage, countMessages, insertOptions, listMessages, deleteMessage } from '../../../utils/game-db'
import { streamChat, consumeChatStream, structuredOutput, chatCompletion } from '../../../utils/ai'
import { uuid } from '../../../../shared/novel'
import type {
  CharacterCard, GameState, TokenUsage, TurnSseEvent, TurnStructured, WorldOverlay
} from '../../../../shared/novel'

type AiRole = 'system' | 'user' | 'assistant'

interface ChatMsg { role: AiRole, content: string }

const TURN_OPTIONS_SCHEMA = `{
  "options": ["选项1", "选项2", "选项3"],
  "state_delta": {
    "location": "地点是否变化(string,无变化省略)",
    "time": "时间描述是否变化(string,无变化省略)",
    "hp": "相对当前 HP 的整数增量,可为负(number,无变化省略)",
    "money": "相对当前金钱的整数增量,可为负(number,无变化省略)",
    "relationships": {"角色名": "相对当前好感度的整数增量,可为负,区间 -100~100 内(number,无变化省略)"},
    "quests": ["任务目标(string)"],
    "flags": {"flag名": true}
  },
  "current_chapter": "当前所处章节标题(string|null)"
}`

/** 进入 prompt 的最近历史消息条数(防止上下文无限膨胀,MVP 沿用简单截断) */
const HISTORY_LIMIT = 12

/** 距上次摘要新增多少条消息后触发一次滚动压缩(防长对话失忆) */
const SUMMARY_EVERY = 6

/** games.summary 列的存储结构:idx=摘要覆盖到的最后一条消息序号 */
interface TurnSummary { idx: number, text: string }

function parseSummary(raw: string | null): TurnSummary | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as TurnSummary
    if (typeof s?.text === 'string' && typeof s?.idx === 'number') return s
  } catch {
    // 旧数据兼容:视为无摘要
  }
  return null
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** 轻量状态引擎:白名单合并 state_delta,数值做增量与钳制;LLM 不直接写库(铁律 3) */
export function mergeState(prev: GameState, delta: TurnStructured['state_delta']): GameState {
  const s: GameState = { ...prev }
  if (delta.location !== undefined) s.location = delta.location
  if (delta.time !== undefined) s.time = delta.time
  if (delta.hp !== undefined) s.hp = clamp((s.hp ?? 100) + delta.hp, 0, 999)
  if (delta.money !== undefined) s.money = clamp((s.money ?? 100) + delta.money, 0, 999999)
  if (delta.quests !== undefined) s.quests = delta.quests
  if (delta.flags !== undefined) s.flags = { ...(s.flags ?? {}), ...delta.flags }
  if (delta.relationships) {
    s.relationships = { ...(s.relationships ?? {}) }
    for (const [name, v] of Object.entries(delta.relationships)) {
      s.relationships[name] = clamp((s.relationships[name] ?? 0) + v, -100, 100)
    }
  }
  return s
}

function parseState(raw: string | null): GameState {
  if (!raw) return { hp: 100, money: 100 }
  try {
    return JSON.parse(raw) as GameState
  } catch {
    return { hp: 100, money: 100 }
  }
}

function cardBrief(c: CharacterCard): string {
  const base = `${c.name}(${c.role},${c.identity ?? '未知身份'})`
  const traits = (c.personality ?? []).slice(0, 4).join('/')
  const speech = (c.speech_style ?? []).slice(0, 2).join('/')
  const stats = [
    c.patience != null ? `耐心${c.patience}` : '',
    c.softness != null ? `心软${c.softness}` : ''
  ].filter(Boolean).join('/')
  return `${base} 性格:${traits || '未知'} 说话风格:${speech || '普通'}${stats ? ` 数值:${stats}` : ''} 背景:${c.background ?? ''}`.trim()
}

/** 组装叙事 prompt(系统规则 + 世界 + 人物卡 + 状态 + 摘要 + 历史 + 玩家本轮输入) */
function buildTurnPrompt(args: {
  world: WorldOverlay
  playerName: string
  playerCard?: CharacterCard
  cards: CharacterCard[]
  state: GameState
  history: { idx: number, role: string, speaker: string | null, content: string }[]
  choice?: string
  summary?: string | null
}): ChatMsg[] {
  const { world, playerName, playerCard, cards, state, history, choice, summary } = args
  const others = cards.filter((c) => c.name !== playerName)

  const system: ChatMsg = {
    role: 'system',
    content: [
      `你是《${world.title ?? '未命名小说'}》的互动叙事引擎。玩家扮演「${playerName}」(${playerCard ? cardBrief(playerCard) : '原著角色'})。`,
      `世界观:${world.genre ?? ''}。${world.summary ?? ''}`,
      `可能出场的其他角色:\n${others.map(cardBrief).join('\n')}`,
      `当前游戏状态:${JSON.stringify(state, null, 0)}`,
      '规则:',
      `1. 以「${playerName}」的第一视角展开场景,用旁白叙事推进;对话行以「角色名:」开头,非玩家角色可自由说话/行动。`,
      '2. 忠于各人物卡的性格与说话风格,不要 OOC。',
      '3. 绝不替玩家说话、决定或行动;剧情为玩家的选择留出空间。',
      '4. 中文输出,一次 1~3 段,节奏紧凑、有画面感;必须承接玩家上一轮的行动或自由输入。',
      '5. 不要输出选项列表(系统另行生成),不要输出任何 JSON 或 Markdown。'
    ].join('\n')
  }

  const parts: string[] = []
  if (summary) parts.push(`【此前剧情摘要】${summary}`)
  for (const m of history.slice(-HISTORY_LIMIT)) {
    if (m.role === 'user') parts.push(`【${m.speaker ?? '玩家'}的行动】${m.content}`)
    else if (m.role === 'character') parts.push(`${m.speaker}: ${m.content}`)
    else parts.push(m.content)
  }
  if (choice) parts.push(`【${playerName}玩家本轮的行动】${choice}`)
  if (parts.length === 0) {
    parts.push(`【开场】故事刚开始,请描写玩家「${playerName}」所处的开场场景,引入剧情与第一个矛盾。`)
  }

  return [system, { role: 'user', content: `【剧情回顾】\n${parts.join('\n\n')}\n\n请以此为接续,生成下一段剧情。` }]
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const body = await readBody<{ choice?: string }>(event).catch(() => ({ choice: undefined }))
  const choice = (body.choice || '').trim()

  const game = await getGame(event, id)
  if (!game) {
    throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  }
  if (game.status === 'ended') {
    throw createError({ statusCode: 400, statusMessage: '游戏已结束' })
  }

  const novel = game.novel_id ? await getNovel(event, game.novel_id) : null
  let world: WorldOverlay | null = null
  if (novel?.world_state) {
    try {
      world = JSON.parse(novel.world_state) as WorldOverlay
    } catch {
      world = null
    }
  }
  const cards = world?.characters ?? []
  const playerName = game.player_character_name ?? '玩家'

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: TurnSseEvent) => {
        const { type, ...payload } = ev
        try {
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`))
        } catch {
          // 客户端已断开
        }
      }
      const fail = (msg: string) => {
        send({ type: 'error', message: msg })
        controller.close()
      }

      try {
        // 1) 玩家行动入库(本轮输入),之后生成的历史会包含它
        let choiceMsgId: string | null = null
        if (choice) {
          choiceMsgId = uuid()
          await appendMessage(event, {
            id: choiceMsgId,
            game_id: id,
            idx: await countMessages(event, id),
            role: 'user',
            speaker: playerName,
            content: choice
          })
        }

        send({ type: 'progress', stage: 'prompt', progress: 10 })
        const state = parseState(game.state)
        const summary = parseSummary(game.summary)
        const history = await listMessages(event, id)
        // 摘要已覆盖的消息不再进 prompt,只保留摘要之后的近期历史
        const historySinceSummary = summary ? history.filter((m) => m.idx > summary.idx) : history

        // 2) 阶段一:流式生成剧情与对话(打字机)
        const prompt = buildTurnPrompt({
          world: world ?? { characters: [] },
          playerName,
          playerCard: cards.find((c) => c.name === playerName),
          cards,
          state,
          history: historySinceSummary,
          choice,
          summary: summary?.text
        })
        const startedAt = Date.now()
        let prose = ''
        let usage: TokenUsage | undefined

        let streamRes: Response
        try {
          streamRes = await streamChat(event, prompt, {
            maxTokens: 1500,
            temperature: 0.8,
            timeoutMs: 300000,
            streamOptions: { include_usage: true },
            thinking: { type: 'disabled' }
          })
        } catch {
          try {
            streamRes = await streamChat(event, prompt, {
              maxTokens: 1500,
              temperature: 0.8,
              timeoutMs: 300000,
              thinking: { type: 'disabled' }
            })
          } catch (e: any) {
            if (choiceMsgId) await deleteMessage(event, choiceMsgId)
            return await fail(`AI 剧情生成失败: ${e?.message ?? e}`)
          }
        }

        // 流式生成期间节流推送实时 token 计数(与上传页一致,估算值)
        let lastEmitAt = 0
        const emitToken = (force = false) => {
          const now = Date.now()
          if (!force && now - lastEmitAt < 120) return
          lastEmitAt = now
          const elapsedMs = now - startedAt
          const chars = prose.length
          const est = Math.max(1, Math.round(chars / 1.7))
          const spd = elapsedMs > 0 ? Math.round((est / elapsedMs) * 1000 * 10) / 10 : 0
          send({ type: 'token', tokens: est, chars, elapsedMs, speed: spd })
        }

        await consumeChatStream(streamRes, {
          onDelta: (d) => {
            prose += d
            send({ type: 'delta', text: d })
            emitToken()
          },
          onUsage: (u) => { usage = u },
          onDone: () => emitToken(true)
        })

        // 3) 阶段二:结构化生成 3 个选项 + 状态变化
        send({ type: 'progress', stage: 'options', progress: 60 })
        const structured = await structuredOutput<TurnStructured>(event, [
          {
            role: 'user',
            content: [
              '以下是本回合刚生成的剧情文本(可能被截断):',
              (prose.length > 2500 ? prose.slice(0, 2500) : prose) || '（剧情为空）',
              '',
              `当前游戏状态:${JSON.stringify(state)}`,
              `请按 schema 输出:3 个贴合剧情走向、符合角色性格的选项;state_delta 只填确定变化的字段(hp/money/relationships 为相对当前状态的增量)。`
            ].join('\n')
          }
        ], {
          schemaHint: TURN_OPTIONS_SCHEMA,
          maxTokens: 1200,
          temperature: 0.4,
          maxRetries: 1,
          thinking: { type: 'disabled' }
        })

        const options = (structured.options ?? []).filter((o) => o && typeof o === 'string').slice(0, 4)
        if (options.length === 0) {
          options.push('继续剧情', '保持观望', '另寻出路')
        }

        // 4) 轻量状态引擎:白名单合并 + 落库
        send({ type: 'progress', stage: 'save', progress: 90 })
        const nextState = mergeState(state, structured.state_delta ?? {})
        const msgIdx = await countMessages(event, id)
        const msgId = uuid()
        await appendMessage(event, {
          id: msgId,
          game_id: id,
          idx: msgIdx,
          role: 'narrator',
          speaker: null,
          content: prose
        })
        await insertOptions(event, options.map((t, i) => ({
          id: uuid(),
          game_id: id,
          message_id: msgId,
          text: t,
          effects: JSON.stringify(structured.state_delta ?? {})
        })))
        await updateGame(event, id, {
          state: JSON.stringify(nextState),
          current_chapter: structured.current_chapter ?? game.current_chapter ?? null
        })

        // 5) 滚动摘要:与上次摘要间隔 >= SUMMARY_EVERY 条时压缩一次(失败不阻塞回合)
        const summaryNow = parseSummary(game.summary)
        if (!summaryNow || msgIdx - summaryNow.idx >= SUMMARY_EVERY) {
          const newMsgs = (await listMessages(event, id)).slice(summaryNow ? summaryNow.idx + 1 : 0)
          try {
            const res = await chatCompletion(event, [
              { role: 'system', content: '把下面的游戏剧情压缩成一段中文摘要(250字以内),保留关键事件、地点、人物关系变化与当前局势。用流畅的叙述文字,不要列点,不要编造原文没有的内容。' },
              { role: 'user', content: `旧摘要:\n${summaryNow?.text ?? '（无）'}\n\n新增剧情:\n${newMsgs.map((m) => `[${m.role}]${m.speaker ? `${m.speaker}: ` : ''}${m.content}`).join('\n\n').slice(0, 6000)}` }
            ], { maxTokens: 400, temperature: 0.3, thinking: { type: 'disabled' } })
            const text = res.content.trim().slice(0, 2000)
            if (text) {
              await updateGame(event, id, { summary: JSON.stringify({ idx: msgIdx, text }) })
            }
          } catch {
            // 摘要失败不影响回合
          }
        }

        send({ type: 'usage', ...(usage ?? {}) })
        send({
          type: 'options',
          list: options.map((t, i) => ({ idx: i, text: t })),
          state: nextState,
          current_chapter: structured.current_chapter ?? game.current_chapter ?? null
        })
        send({ type: 'done' })
        controller.close()
      } catch (e: any) {
        await fail(`回合执行失败: ${e?.message ?? e}`)
      }
    }
  })

  return stream
})