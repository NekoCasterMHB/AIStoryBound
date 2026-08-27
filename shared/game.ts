// shared/game.ts
// 游戏回合的纯逻辑与提示词(浏览器驱动回合复用;服务器旧编排入口可同样引用):
//   状态白名单合并(LLM 只产建议,引擎应用)、人物卡摘要、回合提示词组装、选项 schema。
import { skillPromptBlocks } from './ai-skills'
import { desireTierName } from './novel'
import type { AiSkill } from './ai-skills'
import type { CharacterCard, GameState, LocalGame, TurnStructured } from './novel'

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

/**
 * 回合选项结构化输出 schema(浏览器与服务器共用)。
 * deviceEnabled 为 true 时附加 device_events 字段——设备控制是可选能力,
 * 未开启时不得出现在 schema 里,避免 LLM 凭空生成设备事件。
 */
export function turnOptionsSchema(deviceEnabled: boolean): string {
  const deviceField = deviceEnabled
    ? `,
  "device_events": [
    {"adapter": "目标设备id(缺省当前连接设备;须在下方可用设备列表内)", "function": "功能id(须在下方可用功能列表内)", "intensity": "0-100整数", "mode": "模式档位1-4(可选)", "duration": "持续秒数(可选,到时自动停止)"}
  ]`
    : ''
  return `{
  "options": ["选项1", "选项2", "选项3"],
  "state_delta": {
    "location": "地点是否变化(string,无变化省略)",
    "time": "时间描述是否变化(string,无变化省略)",
    "health": "玩家身体状况描述(string,如「精力充沛」「疲惫」「重伤」,无变化省略)",
    "mood": "玩家心情描述(string,如「平静」「兴奋」「低落」,无变化省略)",
    "relationships": {"角色名": "相对当前好感度的整数增量,可为负,区间 -100~100 内(number,无变化省略)"},
    "desires": {"角色名": "性欲值整数增量,可为负,区间 0~100 内;或 {"delta": 增量, "kink": "本回合触发的玩法名,如 打屁股", "scene": "reward|punish,缺省 reward"}——reward=奖励/自愿(命中「喜欢」大幅加速,「厌恶」几乎不涨);punish=惩罚/强制(犯大错时故意用角色「厌恶」的玩法,羞耻与服从叠加大幅加速);无变化省略"},
    "quests": ["任务目标(string)"],
    "flags": {"flag名": true}
  },
  "current_chapter": "当前所处章节标题(string|null)",
  "summary": "整局剧情摘要(基于旧摘要与上文剧情压缩至 200 字内,保留关键人物关系/伏笔/进展;无重大变化可省略)"${deviceField}
}`
}

/** 设备事件输出规范(回合收尾器提示词的一部分;仅在设备已启用且 AI 开关打开时注入)。
 *  能力暴露给 AI:列出所有已启用适配器的功能清单(连接状态标注),AI 按剧情需要选择目标设备与功能。 */
export interface DeviceCapBrief {
  id: string
  name: string
  connected: boolean
  functions: { id: string, name: string, supportsMode: boolean, modeCount: number }[]
}

export function deviceEventsPrompt(devices: DeviceCapBrief[]): string {
  const lines = devices.map((d) => {
    const fns = d.functions.map(f => `${f.name}${f.supportsMode ? `(0-100,模式1-${f.modeCount})` : '(0-100)'}`).join('、')
    return `- [${d.connected ? '已连接' : '未连接'}] ${d.name}(id: ${d.id}):${fns}`
  }).join('\n')
  return `\n设备事件:本回合若剧情中出现需要实体设备同步响应的身体互动情节(抚摸/高潮/奖励/惩罚等),输出 device_events 数组,0~2 条,每条 {adapter?, function, intensity, mode?, duration?}。可用设备:\n${lines}\nadapter 为目标设备 id(缺省 = 当前连接设备);intensity 为 0-100 整数,与情节强烈程度匹配;mode 为该功能支持的模式档位;duration 为持续秒数(到时设备自动停止)。剧情需要哪个能力就调用哪个;未连接设备的事件会被拒绝。没有设备互动情节就省略 device_events。`
}

/** 性欲值嗜好放大:玩法名与人物卡嗜好 theme 互相包含即命中;多条命中取该场景的最高档。
 *  reward(奖励/自愿):喜欢×2.5 / 接受×1.2 / 厌恶×0.3(抗拒几乎不涨)
 *  punish(惩罚/强制,犯大错时故意挑厌恶的玩法):厌恶×2.5(羞耻与服从叠加,大幅加速) / 喜欢×1.2(不惧罚,效果弱) / 其余×1.0 */
function kinkBoostFactor(card: CharacterCard | undefined, kinkName: string | undefined, scene: 'reward' | 'punish'): number {
  if (!card || !kinkName) return 1
  const k = kinkName.trim()
  if (!k) return 1
  const hits = (card.kinks ?? []).filter(kk => kk.theme && (kk.theme.includes(k) || k.includes(kk.theme)))
  if (hits.length === 0) return 1
  if (scene === 'punish') {
    if (hits.some(h => h.view === '厌恶')) return 2.5
    if (hits.some(h => h.view === '喜欢')) return 1.2
    return 1
  }
  if (hits.some(h => h.view === '喜欢')) return 2.5
  if (hits.some(h => h.view === '接受')) return 1.2
  if (hits.some(h => h.view === '厌恶')) return 0.3
  return 1
}

/** 轻量状态引擎:白名单合并 state_delta,数值做增量与钳制;LLM 不直接写库(铁律 3)
 *  desires 变化曲线:原始增量钳 ±30 × 性欲强度因子(强度/50,0.2~2.0,低=性冷淡波动小)
 *  × 高值加速因子(1+当前值/100,1.0~2.0,低值难涨高值加速) × 嗜好放大(仅正增量,戳中「喜欢」×2.5) */
export function mergeState(prev: GameState, delta: TurnStructured['state_delta'] | undefined, cards?: CharacterCard[]): GameState {
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
  if (delta.desires) {
    s.desires = { ...(s.desires ?? {}) }
    for (const [name, entry] of Object.entries(delta.desires)) {
      const raw = typeof entry === 'number' ? entry : (entry?.delta ?? 0)
      const kink = typeof entry === 'number' ? undefined : entry?.kink
      const scene: 'reward' | 'punish' = typeof entry === 'object' && entry?.scene === 'punish' ? 'punish' : 'reward'
      const cur = s.desires[name] ?? 0
      const card = cards?.find(c => c.name === name)
      const base = (clamp(card?.desire ?? 50, 0, 100) / 50) * (1 + cur / 100)
      const boost = raw > 0 ? kinkBoostFactor(card, kink, scene) : 1
      s.desires[name] = clamp(Math.round(cur + clamp(raw, -30, 30) * base * boost), 0, 100)
    }
  }
  return s
}

/** 为游戏状态播种/补齐各角色的性欲值(初始 = 性欲强度 × 0.3,未知强度 = 0);
 *  新开局与旧存档/存档点回滚(缺失 desires)时调用,保证动态性欲值始终存在 */
export function ensureDesires(state: GameState, cards: CharacterCard[]): GameState {
  if (!cards.length) return state
  const desires = { ...(state.desires ?? {}) }
  let changed = false
  for (const c of cards) {
    if (desires[c.name] == null) {
      desires[c.name] = clamp(Math.round((c.desire ?? 0) * 0.3), 0, 100)
      changed = true
    }
  }
  return changed ? { ...state, desires } : state
}

export function parseState(raw: string | null | undefined): GameState {
  if (!raw) return { health: '良好', mood: '平静' }
  try {
    return JSON.parse(raw) as GameState
  } catch {
    return { health: '良好', mood: '平静' }
  }
}

/** 人物卡的一句话摘要(进 prompt;kinks 全量注入不截断,含具体表现,防止嗜好信息丢失导致 OOC) */
export function cardBrief(c: CharacterCard): string {
  const base = `${c.name}(${c.role},${c.identity ?? '未知身份'})`
  const traits = (c.personality ?? []).slice(0, 4).join('/')
  const speech = (c.speech_style ?? []).slice(0, 2).join('/')
  const stats = [
    c.patience != null ? `耐心${c.patience}` : '',
    c.softness != null ? `心软${c.softness}` : '',
    c.desire != null ? `性欲强度${desireTierName(c.desire)}(${c.desire})` : ''
  ].filter(Boolean).join('/')
  const kinks = (c.kinks ?? [])
    .map(k => `${k.theme}${k.view ? `·${k.view}` : ''}${k.role ? `/${k.role}` : ''}${k.detail ? `(${k.detail})` : ''}`)
    .join(' / ')
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
  /** 已启用的 AI Skill 玩法列表(个人中心技能管理:商城下载后自动启用;限定成人互动可用的玩法菜单) */
  activeSkills?: AiSkill[]
  /** 玩家偏好场景提示词(个人中心设置;优先级低于系统规则) */
  preferScenes?: string
  /** 玩家避免出现的场景提示词(个人中心设置;优先级低于系统规则) */
  avoidScenes?: string
  /** 开局设定(仅首回合无历史时生效;缺省=原有自由开场) */
  opening?: LocalGame['opening']
}

/** 组装叙事 prompt(系统规则 + 世界 + 人物卡 + 状态 + 摘要 + 历史 + 玩家本轮输入) */
export function buildTurnPrompt(args: TurnPromptArgs): ChatMsg[] {
  const { title, genre, summary, playerName, playerCard, cards, state, history, choice, summaryText, adultMode, activeSkills, preferScenes, avoidScenes, opening } = args
  const others = cards.filter(c => c.name !== playerName)

  // 规则:系统规则在前,用户偏好场景/避免场景追加在后,明确声明其优先级低于系统规则
  // AI Skill 玩法:开启的技能按 SKILL.md 正文(含参考附件)完整注入,不做裁剪——
  // 内容被截断的技能失去意义,启停与每轮消耗由用户在技能管理中自行控制(个人中心有实时 token 估算提示)
  const skillRules: string[] = []
  if (activeSkills && activeSkills.length) {
    skillRules.push(
      `本场可用的成人玩法技能:${activeSkills.map(s => s.name).join('、')}。成人互动情节出现时,先按各技能的正文指引判断是否适用,适用则按其步骤与规则展开;未启用玩法尽量不出现。技能内「强度进阶」档位按规则中的强度阶梯判定选择。角色嗜好规则:日常/奖励场景优先用角色「喜欢/接受」的玩法;惩罚场景(角色犯大错且认错态度差)可故意挑角色「厌恶」的玩法——越厌恶越显惩罚之重,羞耻与服从叠加会大幅加速其性欲值累积,并强化抗拒、哭喊与屈辱描写。`
    )
    for (const s of activeSkills) {
      const blocks = skillPromptBlocks(s)
      if (blocks.length === 0) continue
      skillRules.push(`【技能:${s.name}】\n${blocks.join('\n')}`)
    }
  }
  const rules = [
    `以「${playerName}」的第一视角展开场景,用旁白叙事推进;对话行以「角色名:」开头,非玩家角色可自由说话/行动。`,
    '忠于各人物卡的性格与说话风格,不要 OOC。',
    '呼应原著设定,但允许合理分支;避免机械复述原文。',
    '每次回答输出 2~4 段,每段 80~200 字,自然停顿;不要一次写完.结尾留悬念。',
    '本作品为成人向虚构题材,涉及管教、惩罚、亲密与支配互动等情节,按人物卡与原著设定如实描写,涉及此类情节时不要回避或自行弱化。',
    ...(adultMode
      ? ['成人模式已开启:内容明显偏向训诫、BDSM、打屁股(spank)、捆绑、强制与支配等亚文化题材,此类互动出现频率大幅提升,可在连续数回合内推进,描写直白;按各角色人物卡的性欲强度档位、当前性欲值与人物卡中的关系设定把握分寸与推进节奏(如主从/师生关系对应支配与训诫),强制类情节依原作设定与人物关系推进,不需要等到剧情铺垫很久。性欲值(0-100,见游戏状态 desires)随心情、情景与被挑逗程度动态变化:性欲强度低的角色波动小、难以被挑起;性欲值低时上涨缓慢,一旦升高后续上涨加速;戳中角色嗜好「喜欢」的玩法会大幅加速性欲值累积;日常场景「厌恶」的玩法几乎无法累积,但惩罚场景故意使用「厌恶」玩法会因羞耻与服从叠加大幅加速。强度阶梯:技能「强度进阶」档位由 ①角色性格 ②性欲强度 ③当前性欲值 ④本回合犯错大小 ⑤认错态度 综合决定——性冷淡/低性欲值用低档,犯错大且认错态度差可跳高档(此时可故意挑角色厌恶的玩法惩罚,越讨厌罚越重),档位变化要有铺垫、逐级推进。']
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
  // 开场判定基于剧情上下文(摘要/历史),与人设提醒是否注入无关——
  // 人设提醒只要有角色卡就总会注入,若用它挡在开场前面,首回合开场指令会被吞掉
  const hasStoryContext = !!summaryText || history.length > 0
  if (summaryText) {
    parts.push(`【剧情回顾】${summaryText}`)
  }
  const recent = history.slice(-12)
  if (recent.length > 0) {
    parts.push(recent.map(m => (m.role === 'user' ? `【玩家】${m.content}` : `【剧情】${m.content}`)).join('\n'))
  }
  // 首回合(无摘要/无历史)的开场:按开局设定注入对应背景,缺省维持原有自由开场
  if (!hasStoryContext) {
    if (opening?.mode === 'chapter' && opening.chapterText) {
      parts.push(`【当前剧情位置】故事正进行到原著第「${opening.chapterTitle || '未知章节'}」章。以下为该章节完整正文:\n${opening.chapterText}\n\n你此刻正身处该章节的场景之中:场景环境、在场人物、他们的话语与情绪、正在发生的事件,都必须与该章节内容保持一致。请从这一场景的当下状态直接续写,引入剧情与第一个矛盾;后续走向可以自由发展,但不要跳开当前场景,也不要忽略章节中已建立的人物关系与状态。`)
    } else if (opening?.mode === 'custom' && opening.scene?.trim()) {
      parts.push(`【开场】玩家提供的背景设定:${opening.scene.trim()}\n\n请以此为出发点展开,描写玩家「${playerName}」所处的场景,引入剧情与第一个矛盾。`)
    } else if (opening?.mode === 'ai' && opening.scene?.trim()) {
      parts.push(`【开场】本局开场设定:${opening.scene.trim()}\n\n请从该设定的场景与氛围出发展开,描写玩家「${playerName}」所处的场景,引入剧情与第一个矛盾。`)
    } else {
      parts.push(`【开场】故事刚开始,请描写玩家「${playerName}」所处的开场场景,引入剧情与第一个矛盾。`)
    }
  }
  // 防人设漂移:核心人设复述在 user 尾部(长对话后注意力偏离开头 system 的设定,社区验证
  // 此处重贴可显著降低 OOC/指令衰减);位置放在玩家本轮行动之前,不稀释当前指令的注意力
  const anchors = [
    playerCard ? `玩家「${playerName}」:${cardBrief(playerCard)}` : null,
    ...others.slice(0, 3).map(cardBrief)
  ].filter((x): x is string => !!x)
  if (anchors.length > 0) {
    parts.push(`【人设提醒】再次强调,以下核心角色严格忠于设定,勿 OOC:\n${anchors.map((a, i) => `${i + 1}. ${a}`).join('\n')}`)
  }
  if (choice) {
    parts.push(`【玩家本轮行动】${choice}`)
  }

  return [system, { role: 'user', content: `${parts.join('\n\n')}\n\n请以此为接续,生成下一段剧情。` }]
}
