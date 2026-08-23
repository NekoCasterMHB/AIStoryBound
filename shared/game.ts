// shared/game.ts
// 游戏回合的纯逻辑与提示词(浏览器驱动回合复用;服务器旧编排入口可同样引用):
//   状态白名单合并(LLM 只产建议,引擎应用)、人物卡摘要、回合提示词组装、选项 schema。
import type { CharacterCard, GameState, TurnStructured } from './novel'

export type AiRole = 'system' | 'user' | 'assistant'
export interface ChatMsg { role: AiRole, content: string }

export interface TurnSummary { idx: number, text: string }

export function parseSummary(raw: string | null | undefined): TurnSummary | null {
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

/** 回合选项结构化输出 schema(浏览器与服务器共用) */
export const TURN_OPTIONS_SCHEMA = `{
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

/** 轻量状态引擎:白名单合并 state_delta,数值做增量与钳制;LLM 不直接写库(铁律 3) */
export function mergeState(prev: GameState, delta: TurnStructured['state_delta'] | undefined): GameState {
  const s: GameState = { ...prev }
  if (!delta) return s
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

export function parseState(raw: string | null | undefined): GameState {
  if (!raw) return { hp: 100, money: 100 }
  try {
    return JSON.parse(raw) as GameState
  } catch {
    return { hp: 100, money: 100 }
  }
}

/** 人物卡的一句话摘要(进 prompt) */
export function cardBrief(c: CharacterCard): string {
  const base = `${c.name}(${c.role},${c.identity ?? '未知身份'})`
  const traits = (c.personality ?? []).slice(0, 4).join('/')
  const speech = (c.speech_style ?? []).slice(0, 2).join('/')
  const stats = [
    c.patience != null ? `耐心${c.patience}` : '',
    c.softness != null ? `心软${c.softness}` : ''
  ].filter(Boolean).join('/')
  return `${base} 性格:${traits || '未知'} 说话风格:${speech || '普通'}${stats ? ` 数值:${stats}` : ''} 背景:${c.background ?? ''}`.trim()
}

export interface TurnPromptArgs {
  title: string
  genre?: string | null
  summary?: string | null
  playerName: string
  playerCard?: CharacterCard
  cards: CharacterCard[]
  state: GameState
  history: { idx: number, role: string, speaker: string | null, content: string }[]
  choice?: string
  summaryText?: string | null
}

/** 组装叙事 prompt(系统规则 + 世界 + 人物卡 + 状态 + 摘要 + 历史 + 玩家本轮输入) */
export function buildTurnPrompt(args: TurnPromptArgs): ChatMsg[] {
  const { title, genre, summary, playerName, playerCard, cards, state, history, choice, summaryText } = args
  const others = cards.filter(c => c.name !== playerName)

  const system: ChatMsg = {
    role: 'system',
    content: [
      `你是《${title}》的互动叙事引擎。玩家扮演「${playerName}」(${playerCard ? cardBrief(playerCard) : '原著角色'})。`,
      `${[genre && `题材:${genre}`, summary && `故事背景:${summary}`].filter(Boolean).join('。')}`,
      `可能出场的其他角色:\n${others.map(cardBrief).join('\n')}`,
      `当前游戏状态:${JSON.stringify(state, null, 0)}`,
      '规则:',
      `1. 以「${playerName}」的第一视角展开场景,用旁白叙事推进;对话行以「角色名:」开头,非玩家角色可自由说话/行动。`,
      '2. 忠于各人物卡的性格与说话风格,不要 OOC。',
      '3. 呼应原著设定,但允许合理分支;避免机械复述原文。',
      '4. 每次回答输出 2~4 段,每段 80~200 字,自然停顿;不要一次写完.结尾留悬念。'
    ].join('\n')
  }

  const parts: string[] = []
  if (summaryText) {
    parts.push(`【剧情回顾】${summaryText}`)
  }
  const recent = history.slice(-12)
  if (recent.length > 0) {
    parts.push(recent.map(m => (m.role === 'user' ? `【玩家】${m.content}` : `【剧情】${m.content}`)).join('\n'))
  }
  if (parts.length === 0) {
    parts.push(`【开场】故事刚开始,请描写玩家「${playerName}」所处的开场场景,引入剧情与第一个矛盾。`)
  }
  if (choice) {
    parts.push(`【玩家本轮行动】${choice}`)
  }

  return [system, { role: 'user', content: `${parts.join('\n\n')}\n\n请以此为接续,生成下一段剧情。` }]
}
