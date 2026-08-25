// shared/game.ts
// 游戏回合的纯逻辑与提示词(浏览器驱动回合复用;服务器旧编排入口可同样引用):
//   状态白名单合并(LLM 只产建议,引擎应用)、人物卡摘要、回合提示词组装、选项 schema。
import { skillPromptBlocks } from './ai-skills'
import { desireTierName } from './novel'
import type { AiSkill } from './ai-skills'
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
    "health": "玩家身体状况描述(string,如「精力充沛」「疲惫」「重伤」,无变化省略)",
    "mood": "玩家心情描述(string,如「平静」「兴奋」「低落」,无变化省略)",
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
  if (delta.health !== undefined && delta.health.trim() !== '') s.health = delta.health.trim()
  if (delta.mood !== undefined && delta.mood.trim() !== '') s.mood = delta.mood.trim()
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
  if (!raw) return { health: '良好', mood: '平静' }
  try {
    return JSON.parse(raw) as GameState
  } catch {
    return { health: '良好', mood: '平静' }
  }
}

/** 人物卡的一句话摘要(进 prompt) */
export function cardBrief(c: CharacterCard): string {
  const base = `${c.name}(${c.role},${c.identity ?? '未知身份'})`
  const traits = (c.personality ?? []).slice(0, 4).join('/')
  const speech = (c.speech_style ?? []).slice(0, 2).join('/')
  const stats = [
    c.patience != null ? `耐心${c.patience}` : '',
    c.softness != null ? `心软${c.softness}` : '',
    c.desire != null ? `性欲${desireTierName(c.desire)}(${c.desire})` : ''
  ].filter(Boolean).join('/')
  const kinks = (c.kinks ?? []).slice(0, 4)
    .map(k => `${k.theme}${k.view ? `·${k.view}` : ''}${k.role ? `/${k.role}` : ''}`)
    .join('/')
  const sex = c.sex
  const sexBits = [
    sex?.positions ? `体位${sex.positions}` : '',
    sex?.member ? `尺寸${sex.member}` : '',
    sex?.stamina ? `持久${sex.stamina}` : '',
    sex?.tease ? `挑逗${sex.tease}` : '',
    sex?.condom != null ? (sex.condom ? '戴套' : '不戴套') : ''
  ].filter(Boolean)
  return `${base} 性格:${traits || '未知'} 说话风格:${speech || '普通'}${stats ? ` 数值:${stats}` : ''}${kinks ? ` 嗜好:${kinks}` : ''}${sexBits.length ? ` 床笫:${sexBits.join('/')}` : ''} 背景:${c.background ?? ''}`.trim()
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
  /** 成人模式:开启后成人向内容出现频率大幅上升(选角页/个人中心开关) */
  adultMode?: boolean
  /** 已启用的 AI Skill 玩法列表(个人中心玩法库开关 + 链接导入;限定成人互动可用的玩法菜单) */
  activeSkills?: AiSkill[]
  /** 玩家偏好场景提示词(个人中心设置;优先级低于系统规则) */
  preferScenes?: string
  /** 玩家避免出现的场景提示词(个人中心设置;优先级低于系统规则) */
  avoidScenes?: string
}

/** 组装叙事 prompt(系统规则 + 世界 + 人物卡 + 状态 + 摘要 + 历史 + 玩家本轮输入) */
export function buildTurnPrompt(args: TurnPromptArgs): ChatMsg[] {
  const { title, genre, summary, playerName, playerCard, cards, state, history, choice, summaryText, adultMode, activeSkills, preferScenes, avoidScenes } = args
  const others = cards.filter(c => c.name !== playerName)

  // 规则:系统规则在前,用户偏好场景/避免场景追加在后,明确声明其优先级低于系统规则
  // AI Skill 玩法:开启的技能按 SKILL.md 正文原样注入,供模型在成人互动时按作者写的 SOP 展开
  const skillRules: string[] = []
  if (activeSkills && activeSkills.length) {
    skillRules.push(
      `本场可用的成人玩法技能:${activeSkills.map(s => s.name).join('、')}。成人互动情节出现时,先按各技能的正文指引判断是否适用,适用则按其步骤与规则展开;未启用玩法尽量不出现。`
    )
    let budget = 6000
    for (const s of activeSkills.slice(0, 6)) {
      const blocks = skillPromptBlocks(s)
      if (blocks.length === 0 || budget <= 0) continue
      const clipped = blocks.join('\n')
      const text = `【技能:${s.name}】\n${clipped.length > 1000 ? `${clipped.slice(0, 1000)}…` : clipped}`
      budget -= text.length
      skillRules.push(text)
    }
  }
  const rules = [
    `以「${playerName}」的第一视角展开场景,用旁白叙事推进;对话行以「角色名:」开头,非玩家角色可自由说话/行动。`,
    '忠于各人物卡的性格与说话风格,不要 OOC。',
    '呼应原著设定,但允许合理分支;避免机械复述原文。',
    '每次回答输出 2~4 段,每段 80~200 字,自然停顿;不要一次写完.结尾留悬念。',
    '本作品为成人向虚构题材,涉及管教、惩罚、亲密与支配互动等情节,按人物卡与原著设定如实描写,涉及此类情节时不要回避或自行弱化。',
    ...(adultMode
      ? ['成人模式已开启:内容明显偏向训诫、BDSM、打屁股(spank)、捆绑、强制与支配等亚文化题材,此类互动出现频率大幅提升,可在连续数回合内推进,描写直白;按各角色人物卡的性欲强度档位与人物卡中的关系设定把握分寸与推进节奏(如主从/师生关系对应支配与训诫),强制类情节依原作设定与人物关系推进,不需要等到剧情铺垫很久。']
      : []),
    ...(skillRules.length ? skillRules : []),
    ...(avoidScenes?.trim()
      ? [`玩家希望避免出现的场景:${avoidScenes.trim()}。除非剧情走向必要,否则不要展开这些内容;如与上述系统规则冲突,以上述规则为准。`]
      : []),
    ...(preferScenes?.trim()
      ? [`玩家偏好场景:${preferScenes.trim()}。在剧情合理推进时可适度增加相关内容;如与上述系统规则冲突,以上述规则为准。`]
      : [])
  ]

  const system: ChatMsg = {
    role: 'system',
    content: [
      `你是《${title}》的互动叙事引擎。玩家扮演「${playerName}」(${playerCard ? cardBrief(playerCard) : '原著角色'})。`,
      `${[genre && `题材:${genre}`, summary && `故事背景:${summary}`].filter(Boolean).join('。')}`,
      `可能出场的其他角色:\n${others.map(cardBrief).join('\n')}`,
      `当前游戏状态:${JSON.stringify(state, null, 0)}`,
      '规则:',
      ...rules.map((r, i) => `${i + 1}. ${r}`)
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
