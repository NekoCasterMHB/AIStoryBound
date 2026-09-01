// shared/world-build.ts
// 世界观生成流水线的纯函数与提示词(浏览器与服务器共用,零框架依赖):
//   分块 → 提取提示词 → 代码合并(Reduce) → 引用校验 → 一致性检查 → 成书
// 提取/检查/成书的 LLM 调用由浏览器编排,经服务器 /api/ai/chat 中继执行。
import { SEX_TEXT_KEYS, uuid } from './novel'
import type {
  ChapterExtraction, ChapterSegment, CharacterArc, CharacterArcBeat, CharacterCard, CharacterChapterVariant, EntityConflict, EntitySource,
  HeatLevel, KinkProfileEntry, MergedCharacter, PlotBeat, StoryBeat, WorldEntities, WorldOverlay
} from './novel'

// ---- 常量 ----

/** 单个提取单元的正文上限(字符,≈5.9K tokens);超长章节/未切块按段落边界切段 */
export const UNIT_MAX_CHARS = 10000
/** 超限长章切段时的相邻段重叠区(字符,≈590 tokens):减少切段边界处实体/关系的遗漏;个人中心高级设置可调,0=关闭 */
export const UNIT_OVERLAP_CHARS = 1000
/** 成书时进入人物卡的角色数上限(按 mentionCount 取前 N) */
export const TOP_CHARACTERS = 12
/** 引用摘录上限(字符;约 2~3 句话,支撑行为细节类证据如嗜好 detail) */
export const QUOTE_MAX_CHARS = 150
/** 节约模式:单次提取输出上限(5 类核心实体,引用从简);引用加长后同步上调,防挤占实体完整性 */
export const ECO_EXTRACT_MAX_TOKENS = 4600
/** 节约模式:单次提取的引用摘录上限(字符) */
export const ECO_QUOTE_MAX_CHARS = 80
/** 节约模式:成书输出上限(标题/简介/角色定位 + 标签/性向/设定) */
export const ECO_SYNTH_MAX_TOKENS = 1600
/** 提取 schema 版本:写入缓存 key,变更后旧提取缓存作废(避免复用没有 plot_beat / 切段方式不同的结果) */
export const EXTRACT_SCHEMA_VERSION = 5
/** 单角色章节变体上限:只保留前 N 处变化,防止超长作品变体膨胀 */
export const MAX_STAGE_VARIANTS = 30
/** 一致性检查单次输出上限(tokens);个人中心「生成参数-高级设置」可调。默认=主流模型输出上限(384K),等于不限制 */
export const CHECK_MAX_TOKENS = 384000
/** 成书单次输出上限(tokens);个人中心「生成参数-高级设置」可调。默认=主流模型输出上限(384K),等于不限制 */
export const SYNTH_MAX_TOKENS = 384000
/** 平台题材标签:写入生成作品的 overlay.genre,叙事引擎据此知晓题材边界(成人向虚构) */
export const ADULT_GENRE = '成人向'

/** 本地 0 token 聚合:成书润色的草稿,失败时直接写入 overlay */
export interface WorldLocalSummary {
  tags: string[]
  orientation: string
  setting: string
  heat: HeatLevel
  contentWarnings: string[]
  tropes: string[]
  kinkProfile: KinkProfileEntry[]
  /** 5~8 个骨干拍,给成书当全书弧线,不是细纲本体 */
  storySpine: { index: number, summary: string, turn?: string | null }[]
}

// ---- 分块 ----

export interface ExtractUnit {
  /** 1-based 章节号(代码据此填 source_chapter,不依赖模型) */
  chapter: number
  /** 展示标签,如 "第3章" / "第3章(段2)" */
  label: string
  content: string
  /** 本段在全书中的起始字符偏移(细纲排序/游玩窗口用,不依赖章节标题) */
  startChar: number
}

/** 章节 → 提取单元:全书拼成连续文本,纯按字数在段落边界切段(不依赖章节标题,兼容任意 txt)。
 *  相邻段保留 overlapChars 重叠(上限可配,默认 UNIT_MAX_CHARS;0=关闭重叠)。
 *  chapter 字段=段序号(1-based),仅作溯源编号;startChar=段在全书中的起始偏移。 */
export function splitUnits(chapters: ChapterSegment[], maxChars = UNIT_MAX_CHARS, overlapChars = UNIT_OVERLAP_CHARS): ExtractUnit[] {
  // 重叠区不超过上限一半,保证每次切段都有进展
  const overlap = Math.min(Math.max(0, Math.round(overlapChars)), Math.floor(maxChars / 2))
  const full = chapters.map(c => c.content).join('\n')
  const units: ExtractUnit[] = []
  if (!full.trim()) return units
  if (full.length <= maxChars) {
    units.push({ chapter: 1, label: '正文', content: full, startChar: 0 })
    return units
  }
  // 按 '\n' 边界切段(尽量靠近上限,避免把段落切断);下一段从 cut 回退重叠区起,覆盖切点两侧的上下文
  let rest = full
  let offset = 0
  let part = 1
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = maxChars // 段落过长,硬切
    units.push({ chapter: part, label: `第${part}段`, content: rest.slice(0, cut).trim(), startChar: offset })
    const nextLocal = Math.max(0, cut - overlap)
    rest = rest.slice(nextLocal).trim()
    offset += nextLocal
    part++
  }
  if (rest) units.push({ chapter: part, label: `第${part}段`, content: rest, startChar: offset })
  return units
}

// ---- 提示词 ----

/** 性爱属性 schema 片段(提取用;condom 为布尔三态) */
const SEX_SCHEMA_EXTRACT = '"sex": {"positions": "偏好体位|null","habits": "床笫习惯|null","tease": "语言挑逗风格|null","skill": "性能力技巧|null","member": "性器官大小形状|null","stamina": "持久能力|null","figure": "身材曲线|null","fingers": "手指粗细|null","condom": true|false|null}'

/** 单段情节纪要(按字数切段,不依赖章节标题;完整/节约模式都提取) */
const PLOT_BEAT_SCHEMA = '"plot_beat": {"summary": "本段发生了什么,按时间顺序完整保留情节细节(包括起因、经过、关键转折、结局),不要压缩省略","cast": ["出场人名"],"place": "主要地点|null","turn": "本段相对上一段的推进或转折,首段填开端|null","hook": "段末未完成的悬念|null"}'

/** 7 类实体提取的 JSON schema(引用逐字、必填字段带 quote) */
export const EXTRACT_SCHEMA_HINT = `{
  "characters": [{"name": "人名(原文用名)","alias": ["别名/称呼"],"gender": "男/女/未知|null","age": "年龄,null 可","identity": "身份职业|null","appearance": "外貌|null","personality": ["性格特征"],"speech_style": ["说话风格"],"background": "背景|null","abilities": ["能力/技能"],"goals": ["目标动机"],"fears": ["恐惧弱点"],"secrets": ["秘密"],"relationships": [{"name": "对方姓名","type": "关系类型","quote": "支持该关系的原文句"}],"dead": true,"status": "该角色在本段的处境/状态一句话(身份转变、受伤、被囚、身亡等,仅本段可证实)|null","desire": "性欲强度 0-100 整数,按原文行为推断,null 可","kinks": [{"theme": "成人题材玩法,如 打屁股/捆绑/训诫/SM/强制高潮 等","view": "喜欢|厌恶|接受|null","role": "承受|施予|双方|null","quote": "支持该喜好的原文句|null"}],${SEX_SCHEMA_EXTRACT},"quote": "本段最能代表该人物的原文句"}],
  "locations": [{"name": "地点名","type": "类别|null","description": "描述|null","notable": ["标志性的人/事/物"],"quote": "原文句"}],
  "factions": [{"name": "势力名","description": "描述|null","goal": "目标|null","members": ["成员名"],"quote": "原文句"}],
  "timeline_events": [{"time": "时间/先后|null","event": "事件概述","characters_involved": ["人物名"],"quote": "原文句"}],
  "world_rules": [{"category": "力量体系/科技/社会规则/自然法则|null","rule": "规则表述","quote": "原文句"}],
  "items": [{"name": "物品名","description": "描述|null","significance": "对剧情的作用|null","quote": "原文句"}],
  "foreshadowing": [{"hint": "伏笔/悬念概述","quote": "原文句"}],
  ${PLOT_BEAT_SCHEMA}
}`

export const JSON_ONLY_SYSTEM = `你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。`

/** 节约模式:只提取 5 类核心实体(去掉 items/foreshadowing),字段说明从简 */
export const EXTRACT_SCHEMA_HINT_ECO = `{
  "characters": [{"name": "人名(原文用名)","alias": ["别名/称呼"],"gender": "男/女/未知|null","age": "年龄|null","identity": "身份|null","appearance": "外貌|null","personality": ["性格特征"],"speech_style": ["说话风格"],"background": "背景|null","abilities": ["能力/技能"],"goals": ["目标"],"fears": ["弱点"],"secrets": ["秘密"],"relationships": [{"name": "对方姓名","type": "关系类型","quote": "支持该关系的原文句"}],"dead": true,"status": "该角色在本段的处境/状态一句话(身份转变、受伤、被囚、身亡等,仅本段可证实)|null","desire": "性欲强度 0-100 整数,null 可","kinks": [{"theme": "成人题材玩法,如 打屁股/捆绑/训诫/SM/强制高潮 等","view": "喜欢|厌恶|接受|null","role": "承受|施予|双方|null","quote": "支持该喜好的原文句|null"}],${SEX_SCHEMA_EXTRACT},"quote": "最能代表该人物的原文句"}],
  "locations": [{"name": "地点名","type": "类别|null","description": "描述|null","notable": ["标志性的人/事/物"],"quote": "原文句"}],
  "factions": [{"name": "势力名","description": "描述|null","goal": "目标|null","members": ["成员名"],"quote": "原文句"}],
  "timeline_events": [{"time": "时间/先后|null","event": "事件概述","characters_involved": ["人物名"],"quote": "原文句"}],
  "world_rules": [{"category": "力量体系/科技/社会规则/自然法则|null","rule": "规则表述","quote": "原文句"}],
  ${PLOT_BEAT_SCHEMA}
}`

/** 单单元提取请求消息;eco=true 时用精简 schema 与更短引用(节约模式) */
export function buildExtractMessages(title: string, unit: ExtractUnit, eco = false) {
  const quoteMax = eco ? ECO_QUOTE_MAX_CHARS : QUOTE_MAX_CHARS
  const schemaHint = eco ? EXTRACT_SCHEMA_HINT_ECO : EXTRACT_SCHEMA_HINT
  return [
    { role: 'system' as const, content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${schemaHint}` },
    {
      role: 'user' as const,
      content: `小说《${title}》${unit.label}原文如下(<chapter>...</chapter>)。\n`
        + `请提取本段的世界观元素,只输出本段可以证实的信息,按 JSON schema 输出全部 ${eco ? 5 : 7} 类数组(没有则为空数组),并必须输出 plot_beat。\n`
        + '规则:\n'
        + `1. quote 必须逐字摘录原文原句,最多 ${quoteMax} 字;${eco ? 'characters 与 relationships 必须带 quote,其余尽量带' : 'world_rules / timeline_events / foreshadowing / items / relationships 必须带 quote,其余字段尽量带'}。\n`
        + '2. 只输出有新信息量的条目:仅一闪而过、没有任何可证实信息的角色不要列入;已有信息不要重复罗列。\n'
        + '3. 不确定的字段填 null 或省略,不要编造;人物名用原文用名,别名填 alias。\n'
        + '4. plot_beat 只写本段原文能证实的情节,按时间顺序完整保留本段情节细节(起因、经过、关键转折、结局),不要压缩省略;不要预告后文、不要编造未出现的转折。\n'
        + '5. 控制输出篇幅:避免冗余与重复罗列,保持整体输出精简;确保 JSON 完整闭合,不要中途截断。\n'
        + `<chapter>${unit.content}</chapter>`
    }
  ]
}

/** 一致性检查:输入紧凑实体库 + 代码发现的冲突,输出批注 + 新冲突 */
export function buildCheckMessages(title: string, entities: WorldEntities, conflicts: EntityConflict[]) {
  const tr = truncate
  const compact = compactEntities(entities)
  const conflictView = conflicts.map(c => ({
    id: c.id,
    entity: `${c.entityType}:${c.entityName}`,
    field: c.field,
    valueA: c.valueA,
    valueB: c.valueB,
    // 证据引用只留大意(60 字),裁决不依赖逐字全文
    evidenceA: c.evidenceA ? { chapter: c.evidenceA.chapter, quote: tr(c.evidenceA.quote, 60) } : null,
    evidenceB: c.evidenceB ? { chapter: c.evidenceB.chapter, quote: tr(c.evidenceB.quote, 60) } : null
  }))
  const schema = `{
  "reviewed": [{"conflict_id": "原冲突 id 原样拷贝","verdict": "later_wins|first_wins|uncertain|not_conflict","reason": "一句话理由"}],
  "new_conflicts": [{"entity_type": "character|location|faction|timeline_event|world_rule|item","entity_name": "实体名","field": "矛盾字段","evidence_a": {"chapter": 数字章节号},"evidence_b": {"chapter": 数字章节号},"verdict": "later_wins|first_wins|uncertain|not_conflict","reason": "一句话理由"}]
}`
  return [
    { role: 'system' as const, content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${schema}` },
    {
      role: 'user' as const,
      content: `小说《${title}》的合并实体库与代码检测到的设定冲突如下。\n`
        + '请做一致性审查:\n'
        + '1. reviewed:对每条既有冲突给出判倾向 verdict 与一句话 reason。later_wins=后文更可信(剧情推进/反转属此类,比如死亡又复活但原文有交代),first_wins=前文更可信,uncertain=无法判断,not_conflict=不是真冲突。\n'
        + '2. new_conflicts:从实体库中找出代码未发现的新矛盾(同一实体同一字段存在两个不同事实、设定前后矛盾)。evidence_a.chapter 与 evidence_b.chapter 必须是实体库中出现的章节号(两处不同)。\n'
        + '3. 不要编造:所有证据章节号必须来自实体库。\n'
        + '4. 近义表述不算冲突:同一含义的不同措辞、同义改写、风格化修饰不算矛盾;只有事实性相互矛盾(数值、时间、身份、状态无法同时成立)才判为冲突。\n'
        + '5. 同一人物可有多个身份/称谓/别名/伪装:关系链或实体库中反复出现的同一人(身份标注不同)应视为同一实体;身份差异、经历阶段变化、别名伪装都不算冲突。\n'
        + `实体库:\n${JSON.stringify(compact)}\n`
        + `代码冲突:\n${JSON.stringify(conflictView)}`
    }
  ]
}

/** 成书输出中的高层摘要字段(完整/节约模式共用,写进 overlay) */
export const OVERLAY_META_SCHEMA = `
  "tags": ["8到12个短标签:子类型/玩法/关系原型,必须能被草稿或实体支持"],
  "orientation": "男女|女女|男男|混合|不明",
  "setting": "舞台+体系一句话",
  "heat": "淡|中|烈",
  "contentWarnings": ["内容警告短词,无则空数组"],
  "tropes": ["关系或剧情原型"],
  "kinkProfile": [{"theme":"玩法名","count":1,"dominantView":"喜欢|厌恶|接受|无感|null"}]`

/** 成书:前 TOP_CHARACTERS 名角色紧凑卡 + 统计 + 冲突摘要 + 世界正文 + 故事骨干 → 世界观速览 + 完整人物卡 */
export function buildSynthesizeMessages(
  title: string,
  entities: WorldEntities,
  conflicts: EntityConflict[],
  warnings: string[],
  local?: WorldLocalSummary
) {
  const top = [...entities.characters]
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, TOP_CHARACTERS)
    .map(c => ({
      name: c.name,
      alias: c.alias,
      gender: c.gender,
      age: c.age,
      identity: c.identity,
      personality: (c.personality ?? []).slice(0, 10),
      speech_style: (c.speech_style ?? []).slice(0, 6),
      background: c.background,
      abilities: (c.abilities ?? []).slice(0, 8),
      goals: (c.goals ?? []).slice(0, 8),
      relationships: c.relationships,
      desire: c.desire,
      kinks: (c.kinks ?? []).slice(0, 8),
      identityVariants: c.identityVariants,
      appearanceVariants: c.appearanceVariants,
      backgroundVariants: c.backgroundVariants,
      sex: c.sex && Object.keys(c.sex).length ? c.sex : undefined,
      chapters: [...new Set(c.sources.map(s => s.chapter))],
      mentionCount: c.mentionCount
    }))
  const counts = {
    characters: entities.characters.length,
    locations: entities.locations.length,
    factions: entities.factions.length,
    timeline_events: entities.timeline_events.length,
    world_rules: entities.world_rules.length,
    items: entities.items.length,
    foreshadowing: entities.foreshadowing.length
  }
  // 冲突摘要带 valueA/valueB 具体值:成书 AI 据此合并出完整人设(只有 verdict/reason 时模型无从判断)
  const conflictSummary = conflicts.slice(0, 12).map(c => ({
    entity: `${c.entityType}:${c.entityName}.${c.field}`,
    valueA: truncate(c.valueA == null ? null : String(c.valueA), 60),
    valueB: truncate(c.valueB == null ? null : String(c.valueB), 60),
    verdict: c.verdict ?? 'uncertain',
    reason: c.reason
  }))
  const schema = `{
  "title": "小说标题(string)",
  "summary": "一两句话简介(string)",
  "characters": [{
    "name": "角色名(string)",
    "role": "主角/配角/反派(string)",
    "alias": "别名,无则 null(string|null)",
    "gender": "性别(string|null)",
    "age": "年龄,如 约40岁/未知(string|null)",
    "identity": "身份职业(string|null)",
    "appearance": "外貌特征(string|null)",
    "personality": ["性格特征(string)"],
    "speech_style": ["说话风格(string)"],
    "background": "背景故事(string|null)",
    "abilities": ["能力/特殊技能(string)"],
    "goals": ["目标/动机(string)"],
    "fears": ["恐惧/弱点(string)"],
    "secrets": ["秘密(string)"],
    "relationships": [{"name":"对方姓名","type":"关系类型","value":"亲密度 -100~100 整数,依原文关系定"}],
    "first_appearance": "首次出现段落,如 第3段(string|null)",
    "dead": true,
    "patience": "耐心 0-100,越小越急躁,null=信息不足",
    "softness": "心软 0-100,越大越心软,null=信息不足",
    "desire": "性欲强度 0-100,越大欲望越强理智越弱,null=信息不足",
    "kinks": [{"theme": "成人题材玩法:打屁股/捆绑/训诫/SM/强制高潮 等(string)","view": "喜欢/厌恶/接受/无感(string|null)","role": "承受/施予/双方(string|null)","detail": "具体表现、反应与敏感度,如 「打屁股反应强烈,轻打即红」(string|null)"}],
    "sex": {"positions": "偏好体位,如 后入/骑乘(string|null)","habits": "床笫习惯/癖好(string|null)","tease": "语言挑逗风格,如 骚话(string|null)","skill": "性能力/技巧(string|null)","member": "性器官大小形状(string|null)","stamina": "持久能力,如 半小时/很快(string|null)","figure": "身材曲线,如 前凸后翘 S 曲线(string|null)","fingers": "手指粗细,如 修长/粗壮(string|null)","condom": "是否戴套 true/false(null=未知)"}
  }],${OVERLAY_META_SCHEMA}
}`
  const worldSlice = compactWorldSlice(entities)
  const draft = local ?? summarizeWorldLocal(entities)
  return [
    { role: 'system' as const, content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${schema}` },
    {
      role: 'user' as const,
      content: `小说《${title}》的实体库(节选)如下。请生成世界观速览与详细人物卡:\n`
        + '- 只输出下列实体信息的角色,不要新增实体库外的人物;\n'
        + '- 每张卡必须忠实于实体信息,不确定的字段填 null 或空数组,不要编造;\n'
        + `- first_appearance 填最早出现段落(如 "第3段");relationships.value 是 -100~100 的亲密度,依据原文关系定;patience/softness 按实体信息给合理估值,信息不足填 null。\n`
        + '- tags/orientation/setting/heat/contentWarnings/tropes/kinkProfile 只能在下方本地草稿上润色或纠偏,必须能被实体或故事骨干支持;禁止发明地名、势力、体系或玩法。\n'
        + '- 同一角色的多版本身份/外貌/背景(identityVariants/appearanceVariants/backgroundVariants)与已知冲突:相互兼容的描述整合为一套更完整的设定(可并存的都保留,如既是留学生又是作家;不同侧面的背景合并叙述),互斥的按裁决结论(verdict)取信;每张卡输出一套自洽的完整人设,不要罗列多个版本。\n'
        + `人物信息:\n${JSON.stringify(top)}\n`
        + `世界设定(节选):\n${JSON.stringify(worldSlice)}\n`
        + `故事骨干(按文本顺序,不是逐段细纲):\n${JSON.stringify(draft.storySpine)}\n`
        + `本地聚合草稿(请基于此输出高层字段):\n${JSON.stringify(overlayDraftView(draft))}\n`
        + `其余实体统计:\n${JSON.stringify(counts)}\n`
        + `已知冲突(已按后文为准裁决,不要回避,在卡内按实体库信息作答):\n${JSON.stringify(conflictSummary)}\n`
        + `生成告警:\n${JSON.stringify(warnings.slice(0, 10))}`
    }
  ]
}

// ---- 节约模式:轻量成书(标题/简介/角色定位)与本地人物卡 ----

/** 节约模式成书:只出标题/简介/角色定位(主角/配角/反派),人物卡主体本地直拼 */
export const ECO_SYNTH_SCHEMA = `{
  "title": "小说标题(string)",
  "summary": "两三句话的世界观简介(string)",
  "roles": [{"name": "角色名(string,必须是下方列表中的名字)","role": "主角|配角|反派(string)"}],${OVERLAY_META_SCHEMA}
}`

/** 节约模式成书请求:输入只给头部角色的轻量素材 + 世界节选 + 故事骨干 + 本地草稿 */
export function buildEcoSynthMessages(title: string, entities: WorldEntities, local?: WorldLocalSummary) {
  const tr = truncate
  const top = [...entities.characters]
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, TOP_CHARACTERS)
    .map(c => ({
      name: c.name,
      gender: c.gender,
      age: c.age,
      identity: c.identity,
      personality: (c.personality ?? []).slice(0, 6),
      background: tr(c.background, 100),
      mentionCount: c.mentionCount
    }))
  const counts = {
    characters: entities.characters.length,
    locations: entities.locations.length,
    factions: entities.factions.length,
    timeline_events: entities.timeline_events.length,
    world_rules: entities.world_rules.length
  }
  const draft = local ?? summarizeWorldLocal(entities)
  return [
    { role: 'system' as const, content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${ECO_SYNTH_SCHEMA}` },
    {
      role: 'user' as const,
      content: `小说《${title}》的实体库(节选)如下。请给出小说标题、两三句话的世界观简介,并为下列每个角色标注定位:\n`
        + '- roles.name 必须原样使用列表中的名字,不要改名、不要新增列表外人物;\n'
        + '- role 依据出场比重与剧情作用:主角=主要视角人物,反派=与主角对立的主要人物,其余为配角;\n'
        + '- summary 概括世界观特色(题材、舞台、核心矛盾),不要编造实体库外的设定。\n'
        + '- tags/orientation/setting/heat/contentWarnings/tropes/kinkProfile 只能在下方本地草稿上润色或纠偏,必须能被实体或故事骨干支持;禁止发明地名、势力、体系或玩法。\n'
        + `人物信息:\n${JSON.stringify(top)}\n`
        + `世界设定(节选):\n${JSON.stringify(compactWorldSlice(entities))}\n`
        + `故事骨干:\n${JSON.stringify(draft.storySpine)}\n`
        + `本地聚合草稿:\n${JSON.stringify(overlayDraftView(draft))}\n`
        + `其余实体统计:\n${JSON.stringify(counts)}`
    }
  ]
}

/** eco 兜底:多版本表述代码拼接(不跑成书 AI,不能丢信息);超长时保留先出现的若干条 */
function joinVariants(parts: string[] | undefined, sep: string, maxLen: number): string | null {
  if (!parts?.length) return null
  let out = ''
  for (const p of parts) {
    const cand = out ? `${out}${sep}${p}` : p
    if (cand.length > maxLen) break
    out = cand
  }
  return out || null
}

/** 节约模式人物卡:由合并实体直接拼卡(无 LLM 润色);roles 可按名字覆盖定位 */
export function buildLocalCards(entities: WorldEntities, roles?: { name?: string, role?: string }[]): CharacterCard[] {
  const roleMap = new Map((roles ?? []).map(r => [norm(r.name ?? ''), r.role ?? '']))
  return [...entities.characters]
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, TOP_CHARACTERS)
    .map((c, i) => {
      const firstChapter = c.sources.length > 0 ? Math.min(...c.sources.map(s => s.chapter)) : null
      const alias = (c.alias ?? []).slice(0, 3).join('、') || null
      const r = roleMap.get(norm(c.name))
      return {
        name: c.name,
        role: r && /^(主角|配角|反派)$/.test(r) ? r : (i === 0 ? '主角' : '配角'),
        alias: alias || undefined,
        gender: c.gender ?? null,
        age: c.age ?? null,
        identity: joinVariants(c.identityVariants, '/', 60) ?? c.identity ?? null,
        appearance: joinVariants(c.appearanceVariants, '；', 200) ?? c.appearance ?? null,
        personality: c.personality ?? [],
        speech_style: c.speech_style ?? [],
        background: joinVariants(c.backgroundVariants, '；', 300) ?? c.background ?? null,
        abilities: c.abilities ?? [],
        goals: c.goals ?? [],
        fears: c.fears ?? [],
        secrets: c.secrets ?? [],
        relationships: (c.relationships ?? []).map(rel => ({ name: rel.name, type: rel.type, value: 0 })),
        first_appearance: firstChapter ? `第${firstChapter}段` : null,
        dead: c.dead ?? null,
        desire: c.desire ?? null,
        kinks: (c.kinks ?? []).slice(0, 8).map(k => ({
          theme: k.theme,
          view: k.view ?? null,
          role: k.role ?? null,
          detail: k.quote ? truncate(k.quote, 120) : null
        })),
        sex: c.sex && Object.keys(c.sex).length ? { ...c.sex } : undefined,
        chapterVariants: (c.chapterVariants ?? []).length ? c.chapterVariants : undefined
      }
    })
}

// ---- Reduce:代码合并(无 LLM) ----

/** 字符串截断(检查/成书输入压缩用) */
function truncate(s: string | null | undefined, n = 120): string | null {
  return s && s.length > n ? `${s.slice(0, n)}…` : (s ?? null)
}

function norm(s: string): string {
  return (s ?? '').replace(/\s+/g, '').trim()
}

function normAny(v: unknown): string {
  if (typeof v === 'object' && v !== null) return norm(JSON.stringify(v))
  return norm(String(v))
}

function safeScalar(v: unknown): string | boolean | number | null | undefined {
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' || v === null || v === undefined) return v
  return String(v)
}

/** 合并全部单元提取 → 实体库 + 冲突清单(别名消歧、标量后文为准、数组去重并集) */
/** 角色章节变体追踪的标量字段(相邻快照 diff 出 patch) */
const VARIANT_SCALAR_FIELDS = ['identity', 'appearance', 'desire'] as const

/** 单提取单元的角色标量快照(章节变体 diff 素材;合并过程中逐段记录) */
interface CharacterUnitSnapshot {
  /** 1-based 段序号(溯源) */
  unit: number
  /** 本段在全书中的起始偏移(映射章节用;-1=未知) */
  startChar: number
  /** 本段处境/状态一句话(模型提取) */
  status?: string | null
  identity?: string | null
  appearance?: string | null
  dead?: boolean | null
  desire?: number | null
  sex?: Record<string, unknown> | null
}

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** 可并存文本字段(身份/外貌/背景):同一角色在不同章节的表述收集为版本列表,差异不记冲突、不覆盖。
 *  实体本体保留最后一次值(快照/eco 兜底用);版本列表在成书阶段交给 AI 合并出完整人设。 */
const VARIANT_TEXT_FIELDS = ['identity', 'appearance', 'background'] as const
type VariantTextField = typeof VARIANT_TEXT_FIELDS[number]

/** 版本收集:归一化去重;互相包含时保留更完整的表述(吸收"同一件事的更完整说法")。返回是否有变化 */
function absorbVariant(parts: string[], value: unknown): boolean {
  if (!hasText(value)) return false
  const v = value.trim()
  const nv = norm(v)
  if (parts.some(p => norm(p) === nv)) return false
  const idx = parts.findIndex(p => norm(p).includes(nv) || nv.includes(norm(p)))
  if (idx >= 0) {
    if (v.length > parts[idx]!.length) parts[idx] = v
    return true
  }
  parts.push(v)
  return true
}

/** 由按段快照序列生成阶段变体:相邻快照 diff,值变化才记录;首拍记录起点值(基底卡是全书终态,前期段需要起点)。
 *  finalDead=该角色全书终态是否死亡:首拍未死而终态已死时,首拍显式记录 dead:false,防止前期段继承终态死亡。
 *  同段内多拍合并为一条;段号直接取快照的单元序号(unit 为 1-based 段序),不经过章节;每卡上限 MAX_STAGE_VARIANTS 条(超出丢弃尾部)。 */
function buildStageVariants(snaps: CharacterUnitSnapshot[], finalDead: boolean): CharacterChapterVariant[] {
  const out: CharacterChapterVariant[] = []
  let prev: CharacterUnitSnapshot | null = null
  for (const s of snaps) {
    if (s.unit < 1) continue
    const stage = s.unit - 1
    const patch: Record<string, unknown> = {}
    for (const f of VARIANT_SCALAR_FIELDS) {
      const cur = s[f]
      if (!hasText(cur) && typeof cur !== 'number') continue
      if (!prev || prev[f] !== cur) patch[f] = cur
    }
    const deadVal = s.dead === true
    const prevDead = prev ? prev.dead === true : finalDead
    if (deadVal !== prevDead) patch.dead = deadVal
    // 性爱属性逐键 diff
    if (s.sex && Object.keys(s.sex).length) {
      const sexPatch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(s.sex)) {
        if (v === undefined || v === null || v === '') continue
        if (!prev?.sex || prev.sex[k] !== v) sexPatch[k] = v
      }
      if (Object.keys(sexPatch).length) patch.sex = sexPatch
    }
    // status:与上一拍不同才记录,避免同状态每章重复
    const status = hasText(s.status) ? s.status.trim() : null
    const last = out[out.length - 1]
    if (last && last.stage === stage) {
      // 同段多拍:并入已有变体(patch 后写覆盖前写)
      Object.assign(last.patch, patch)
      if (status) last.status = status
    } else if (Object.keys(patch).length > 0 || status) {
      out.push({ stage, title: `第${s.unit}段`, status, patch: patch as CharacterChapterVariant['patch'] })
    }
    prev = s
  }
  return out.length > MAX_STAGE_VARIANTS ? out.slice(0, MAX_STAGE_VARIANTS) : out
}

/** 合并全部单元提取 → 实体库 + 冲突清单(别名消歧、标量后文为准、数组去重并集)。
 *  同时按段快照为出场最多的角色生成阶段变体(chapterVariants,段语义)。 */
export function mergeExtractions(
  units: { chapter: number, extract: ChapterExtraction, startChar?: number }[]
): { entities: WorldEntities, conflicts: EntityConflict[] } {
  const conflicts: EntityConflict[] = []

  // 别名消歧:name + alias → 正名
  const aliasToCanonical = new Map<string, string>()
  for (const u of units) {
    for (const c of u.extract.characters ?? []) {
      const canonical = norm(c.name)
      aliasToCanonical.set(canonical, canonical)
      for (const a of c.alias ?? []) {
        const key = norm(a)
        if (!aliasToCanonical.has(key)) aliasToCanonical.set(key, canonical)
      }
    }
  }
  const resolve = (name: string) => aliasToCanonical.get(norm(name)) ?? norm(name)

  interface Acc {
    key: string
    displayName: string
    sources: EntitySource[]
    mentionCount: number
    /** 字段名 → 该标量最近一次写入的来源(冲突证据用) */
    scalarSources: Record<string, EntitySource>
    /** 按段标量快照(仅角色;章节变体 diff 素材) */
    snaps: CharacterUnitSnapshot[]
    /** 可并存文本字段的版本收集(仅角色字段用;跨实体类型统一初始化为空) */
    textParts: Record<VariantTextField, string[]>
    // 合并字段类型混杂(标量/数组/关系对),统一按 unknown 存取
    entity: Record<string, unknown>
  }

  const chars = new Map<string, Acc>()
  const locs = new Map<string, Acc>()
  const factionMap = new Map<string, Acc>()
  const events = new Map<string, Acc>()
  const rules = new Map<string, Acc>()
  const items = new Map<string, Acc>()
  const foreshadow = new Map<string, Acc>()

  /** 标量字段:首个非空为初值;后续不同 → 记冲突(双证据),按"后文为准"覆盖 */
  const mergeScalar = (
    acc: Acc, field: string, value: unknown, source: EntitySource, entityType: string
  ) => {
    if (value === undefined || value === null || value === '') return
    const prev = acc.entity[field]
    // age 模型可能输出数字(如 25),统一转字符串,避免下游 cardBrief 的 age.trim() 在数字上抛错
    if (field === 'age' && typeof value === 'number' && Number.isFinite(value)) {
      value = String(value)
    }
    if (prev === undefined || prev === null || prev === '') {
      acc.entity[field] = value
      acc.scalarSources[field] = source
      return
    }
    if (prev === value) return
    conflicts.push({
      id: uuid(),
      entityType, entityName: acc.displayName, field,
      valueA: safeScalar(prev), valueB: safeScalar(value),
      evidenceA: acc.scalarSources[field], evidenceB: source, source: 'merge'
    })
    acc.entity[field] = value
    acc.scalarSources[field] = source
  }

  /** 数组字段:规整字符串去重并集 */
  const mergeArray = (acc: Acc, field: string, values: unknown[]) => {
    if (!Array.isArray(values) || values.length === 0) return
    const cur: unknown[] = Array.isArray(acc.entity[field]) ? acc.entity[field] as unknown[] : []
    const seen = new Set(cur.map(normAny))
    for (const v of values) {
      const key = normAny(v)
      if (!seen.has(key)) {
        cur.push(v)
        seen.add(key)
      }
    }
    acc.entity[field] = cur
  }

  const getOrCreate = (map: Map<string, Acc>, key: string, displayName: string, make: () => Record<string, unknown>): Acc => {
    let acc = map.get(key)
    if (!acc) {
      acc = { key, displayName, sources: [], mentionCount: 0, scalarSources: {}, snaps: [], textParts: { identity: [], appearance: [], background: [] }, entity: make() }
      map.set(key, acc)
    }
    return acc
  }

  const addSource = (acc: Acc, source: EntitySource) => {
    acc.sources.push(source)
    acc.mentionCount++
  }

  const initEntity = (name: string) => ({ name, sources: [] as EntitySource[], mentionCount: 0 })

  for (const u of units) {
    const source: EntitySource = { chapter: u.chapter }
    const ex = u.extract

    for (const c of ex.characters ?? []) {
      const key = resolve(c.name)
      const acc = getOrCreate(chars, key, c.name || key, () => initEntity(c.name || key))
      const src = { ...source, quote: c.quote || null }
      addSource(acc, src)
      mergeScalar(acc, 'gender', c.gender, src, 'character')
      mergeScalar(acc, 'age', c.age, src, 'character')
      // 身份/外貌/背景是可并存描述(既是留学生又是作家;两段背景说同一件事的不同侧面):
      // 收集全部不同表述,不记冲突、不覆盖;本体保留最后一次值,版本列表成书时交给 AI 合并
      for (const f of VARIANT_TEXT_FIELDS) {
        if (absorbVariant(acc.textParts[f], c[f])) {
          acc.entity[f] = c[f]
        }
      }
      mergeScalar(acc, 'dead', c.dead, src, 'character')
      // 性欲强度随剧情推进会自然变化(成长线),按"后文为准"覆盖但不算设定冲突,避免刷爆冲突列表
      if (c.desire !== undefined && c.desire !== null) {
        const d = Number(c.desire)
        if (Number.isFinite(d)) acc.entity.desire = Math.min(100, Math.max(0, Math.round(d)))
      }
      // 题材喜好按 theme 去重并集;同题材视好感随剧情变化,后文覆盖
      for (const k of c.kinks ?? []) {
        if (!k || !k.theme) continue
        const cur = (acc.entity.kinks ?? []) as { theme: string, view?: string | null, role?: string | null, quote?: string | null }[]
        const idx = cur.findIndex(x => norm(x.theme) === norm(k.theme))
        const existing = cur[idx]
        if (existing) {
          cur[idx] = { theme: k.theme, view: k.view ?? existing.view, role: k.role ?? existing.role, quote: k.quote ?? existing.quote }
        } else {
          cur.push({ theme: k.theme, view: k.view ?? null, role: k.role ?? null, quote: k.quote ?? null })
        }
        acc.entity.kinks = cur
      }
      // 性爱属性:逐字段按"后文为准"合并,缺失字段保留旧值(与性欲/喜好一致,不算设定冲突)
      if (c.sex && typeof c.sex === 'object') {
        const accSex = (acc.entity.sex ?? {}) as Record<string, unknown>
        for (const k of [...SEX_TEXT_KEYS, 'condom'] as const) {
          const v = c.sex[k]
          if (v === undefined || v === null || v === '') continue
          accSex[k] = v // condom=false 也是有效值,需保留
        }
        acc.entity.sex = accSex
      }
      mergeArray(acc, 'alias', c.alias ?? [])
      mergeArray(acc, 'personality', c.personality ?? [])
      mergeArray(acc, 'speech_style', c.speech_style ?? [])
      mergeArray(acc, 'abilities', c.abilities ?? [])
      mergeArray(acc, 'goals', c.goals ?? [])
      mergeArray(acc, 'fears', c.fears ?? [])
      mergeArray(acc, 'secrets', c.secrets ?? [])
      // relationships 按 (name,type) 去重并集
      for (const rel of c.relationships ?? []) {
        const cur = (acc.entity.relationships ?? []) as { name: string, type: string }[]
        if (!cur.some(r => norm(r.name) === norm(rel.name) && norm(r.type) === norm(rel.type))) {
          cur.push({ name: rel.name, type: rel.type })
        }
        acc.entity.relationships = cur
      }
      // 阶段变体素材:记录本段结束后的标量累积值 + 本段 status
      {
        acc.snaps.push({
          unit: u.chapter,
          startChar: u.startChar ?? -1,
          status: hasText(c.status) ? c.status.trim() : null,
          identity: hasText(acc.entity.identity) ? acc.entity.identity as string : null,
          appearance: hasText(acc.entity.appearance) ? acc.entity.appearance as string : null,
          dead: acc.entity.dead === true,
          desire: typeof acc.entity.desire === 'number' ? acc.entity.desire : null,
          sex: acc.entity.sex ? { ...(acc.entity.sex as Record<string, unknown>) } : null
        })
      }
    }

    for (const l of ex.locations ?? []) {
      const key = norm(l.name)
      const acc = getOrCreate(locs, key, l.name || key, () => initEntity(l.name || key))
      const src = { ...source, quote: l.quote || null }
      addSource(acc, src)
      mergeScalar(acc, 'type', l.type, src, 'location')
      mergeScalar(acc, 'description', l.description, src, 'location')
      mergeArray(acc, 'notable', l.notable ?? [])
    }

    for (const f of ex.factions ?? []) {
      const key = norm(f.name)
      const acc = getOrCreate(factionMap, key, f.name || key, () => initEntity(f.name || key))
      const src = { ...source, quote: f.quote || null }
      addSource(acc, src)
      mergeScalar(acc, 'description', f.description, src, 'faction')
      mergeScalar(acc, 'goal', f.goal, src, 'faction')
      mergeArray(acc, 'members', f.members ?? [])
    }

    for (const e of ex.timeline_events ?? []) {
      const key = norm(e.event)
      const acc = getOrCreate(events, key, e.event || key, () => initEntity(e.event || key))
      const src = { ...source, quote: e.quote || null }
      addSource(acc, src)
      mergeScalar(acc, 'time', e.time, src, 'timeline_event')
      mergeArray(acc, 'characters_involved', e.characters_involved ?? [])
    }

    for (const r of ex.world_rules ?? []) {
      const key = norm(r.rule)
      const acc = getOrCreate(rules, key, r.rule || key, () => initEntity(r.rule || key))
      const src = { ...source, quote: r.quote || null }
      addSource(acc, src)
      mergeScalar(acc, 'category', r.category, src, 'world_rule')
    }

    for (const it of ex.items ?? []) {
      const key = norm(it.name)
      const acc = getOrCreate(items, key, it.name || key, () => initEntity(it.name || key))
      const src = { ...source, quote: it.quote || null }
      addSource(acc, src)
      mergeScalar(acc, 'description', it.description, src, 'item')
      mergeScalar(acc, 'significance', it.significance, src, 'item')
    }

    for (const f of ex.foreshadowing ?? []) {
      const key = norm(f.hint)
      const acc = getOrCreate(foreshadow, key, f.hint || key, () => initEntity(f.hint || key))
      addSource(acc, { ...source, quote: f.quote || null })
    }
  }

  // 阶段变体:按段快照 diff 为出场最多的 TOP_CHARACTERS 个角色生成(成卡阶段挂到卡上)
  {
    const top = [...chars.values()].sort((a, b) => b.mentionCount - a.mentionCount).slice(0, TOP_CHARACTERS)
    for (const acc of top) {
      if (!acc.snaps.length) continue
      const variants = buildStageVariants(acc.snaps, acc.entity.dead === true)
      if (variants.length) acc.entity.chapterVariants = variants
    }
  }

  // 可并存文本字段的多版本表述挂到实体上(成书 AI 合并完整人设用;仅多版本时携带,控制 payload)
  for (const acc of chars.values()) {
    const ent = acc.entity as unknown as MergedCharacter
    if (acc.textParts.identity.length > 1) ent.identityVariants = [...acc.textParts.identity]
    if (acc.textParts.appearance.length > 1) ent.appearanceVariants = [...acc.textParts.appearance]
    if (acc.textParts.background.length > 1) ent.backgroundVariants = [...acc.textParts.background]
  }

  return {
    entities: {
      characters: [...chars.values()].map(a => a.entity as unknown as MergedCharacter),
      locations: [...locs.values()].map(a => a.entity as unknown as WorldEntities['locations'][number]),
      factions: [...factionMap.values()].map(a => a.entity as unknown as WorldEntities['factions'][number]),
      timeline_events: [...events.values()].map(a => a.entity as unknown as WorldEntities['timeline_events'][number]),
      world_rules: [...rules.values()].map(a => a.entity as unknown as WorldEntities['world_rules'][number]),
      items: [...items.values()].map(a => a.entity as unknown as WorldEntities['items'][number]),
      foreshadowing: [...foreshadow.values()].map(a => a.entity as unknown as WorldEntities['foreshadowing'][number])
    },
    conflicts
  }
}

// ---- 引用校验(纯代码,替代人工抽查) ----

const normQuote = (s: string) => s.replace(/\s+/g, '').replace(/[，。！？、；：""''（）《》]/g, '')

/** 把实体库中每条 quote 与所在提取段原文比对(空白/标点归一化后子串匹配),不匹配标记 verified=false。
 *  segments: 按字数切段后的段文本数组,下标+1 即 EntitySource.chapter(段号,非章节号)。 */
export function verifyQuotes(entities: WorldEntities, segments: { title: string, content: string }[]): { unverified: number } {
  const texts = new Map<number, string>()
  segments.forEach((seg, i) => {
    texts.set(i + 1, seg.content)
  })
  let unverified = 0
  const verifySources = (sources: EntitySource[]) => {
    for (const s of sources) {
      if (!s.quote) continue
      const text = texts.get(s.chapter)
      if (!text) {
        s.verified = false
        unverified++
        continue
      }
      const q = normQuote(s.quote)
      s.verified = q.length > 0 && normQuote(text).includes(q)
      if (!s.verified) unverified++
    }
  }
  for (const list of [
    entities.characters, entities.locations, entities.factions, entities.timeline_events,
    entities.world_rules, entities.items, entities.foreshadowing
  ]) {
    for (const e of list) verifySources(e.sources)
  }
  return { unverified }
}

// ---- 检查输入压缩 ----

/** 紧凑序列化实体库(值截断 + 章节号列表;不带 quote,控制检查调用输入体积) */
export function compactEntities(entities: WorldEntities) {
  const tr = truncate
  const chaptersOf = (sources: EntitySource[]) => [...new Set(sources.map(s => s.chapter))].sort((a, b) => a - b)
  return {
    characters: entities.characters.map(c => ({
      name: c.name, gender: c.gender, age: c.age, identity: c.identity,
      personality: (c.personality ?? []).map(v => tr(v, 40)),
      background: tr(c.background), abilities: (c.abilities ?? []).map(v => tr(v, 40)),
      goals: (c.goals ?? []).map(v => tr(v, 40)), dead: c.dead, chapters: chaptersOf(c.sources)
    })),
    locations: entities.locations.map(l => ({ name: l.name, type: l.type, description: tr(l.description), chapters: chaptersOf(l.sources) })),
    factions: entities.factions.map(f => ({ name: f.name, description: tr(f.description), goal: tr(f.goal), members: (f.members ?? []).slice(0, 10), chapters: chaptersOf(f.sources) })),
    timeline_events: entities.timeline_events.map(e => ({ event: tr(e.event, 100), time: e.time, chapters: chaptersOf(e.sources) })),
    world_rules: entities.world_rules.map(r => ({ rule: tr(r.rule, 100), category: r.category, chapters: chaptersOf(r.sources) })),
    items: entities.items.map(i => ({ name: i.name, description: tr(i.description), chapters: chaptersOf(i.sources) })),
    foreshadowing: entities.foreshadowing.map(f => ({ hint: tr(f.hint, 80), chapters: chaptersOf(f.sources) }))
  }
}

// ---- 提取输出规范化 / 引用回填 / 成书后处理(浏览器编排与预生成脚本共用,保证产物一致) ----

function normalizePlotBeat(raw: unknown): PlotBeat | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const summary = typeof b.summary === 'string' ? b.summary.trim() : ''
  if (!summary) return null
  const cast = Array.isArray(b.cast)
    ? b.cast.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map(n => n.trim())
    : []
  const place = typeof b.place === 'string' && b.place.trim() ? b.place.trim() : null
  const turn = typeof b.turn === 'string' && b.turn.trim() ? b.turn.trim() : null
  const hook = typeof b.hook === 'string' && b.hook.trim() ? b.hook.trim() : null
  return { summary, cast, place, turn, hook }
}

/** 校验提取输出的结构,返回数组字段齐全的规范化结果 */
export function normalizeExtraction(raw: unknown): ChapterExtraction {
  const r = (raw ?? {}) as Partial<ChapterExtraction>
  return {
    characters: Array.isArray(r.characters) ? r.characters : [],
    locations: Array.isArray(r.locations) ? r.locations : [],
    factions: Array.isArray(r.factions) ? r.factions : [],
    timeline_events: Array.isArray(r.timeline_events) ? r.timeline_events : [],
    world_rules: Array.isArray(r.world_rules) ? r.world_rules : [],
    items: Array.isArray(r.items) ? r.items : [],
    foreshadowing: Array.isArray(r.foreshadowing) ? r.foreshadowing : [],
    plot_beat: normalizePlotBeat(r.plot_beat)
  }
}

/** 提取全失败时的空占位(合并阶段按 0 实体处理) */
export function emptyExtraction(): ChapterExtraction {
  return { characters: [], locations: [], factions: [], timeline_events: [], world_rules: [], items: [], foreshadowing: [], plot_beat: null }
}

/** 按提取单元顺序拼完整故事线;失败或空拍跳过不编造,gaps 供调用方写入 warnings */
export function assembleStoryline(
  units: ExtractUnit[],
  extracts: (ChapterExtraction | null)[]
): { storyline: StoryBeat[], gaps: number[] } {
  const storyline: StoryBeat[] = []
  const gaps: number[] = []
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]
    const beat = extracts[i]?.plot_beat
    if (!unit || !beat?.summary?.trim()) {
      gaps.push(i)
      continue
    }
    storyline.push({
      index: i,
      startChar: unit.startChar,
      label: unit.label,
      summary: beat.summary.trim(),
      cast: beat.cast ?? [],
      place: beat.place ?? null,
      turn: beat.turn ?? null,
      hook: beat.hook ?? null
    })
  }
  return { storyline, gaps }
}

const HEAT_LEVELS: HeatLevel[] = ['淡', '中', '烈']
const ORIENTATIONS = ['男女', '女女', '男男', '混合', '不明'] as const

const KINK_ALIASES: Record<string, string> = {
  spank: '打屁股', spanking: '打屁股', 掌掴: '打屁股', 打pp: '打屁股',
  bondage: '捆绑', bdsm: 'SM', sm: 'SM',
  强制高潮: '强制高潮', 非自愿: '强制', 强迫: '强制', noncon: '强制',
  公开: '公开', 露出: '公开'
}

function canonKinkTheme(raw: string): string {
  const t = (raw ?? '').replace(/\s+/g, '').trim()
  if (!t) return ''
  const lower = t.toLowerCase()
  return KINK_ALIASES[lower] ?? KINK_ALIASES[t] ?? t
}

function genderOf(name: string, entities: WorldEntities): string | null {
  const key = norm(name)
  const hit = entities.characters.find(c => norm(c.name) === key || (c.alias ?? []).some(a => norm(a) === key))
  const g = hit?.gender?.trim()
  if (!g || g === '未知') return null
  if (g.includes('女')) return '女'
  if (g.includes('男')) return '男'
  return null
}

function inferOrientation(entities: WorldEntities): string {
  let mf = 0
  let ff = 0
  let mm = 0
  for (const c of entities.characters) {
    const g1 = genderOf(c.name, entities)
    if (!g1) continue
    for (const rel of c.relationships ?? []) {
      const type = (rel.type ?? '').toLowerCase()
      if (!/(爱|恋|情|配|夫妻|男友|女友|性|床)/.test(type) && !/(爱|恋|情)/.test(rel.type ?? '')) continue
      const g2 = genderOf(rel.name, entities)
      if (!g2) continue
      if (g1 !== g2) mf++
      else if (g1 === '女') ff++
      else mm++
    }
  }
  const total = mf + ff + mm
  if (total === 0) return '不明'
  const mixed = [mf, ff, mm].filter(n => n > 0).length > 1
  if (mixed && Math.max(mf, ff, mm) / total < 0.7) return '混合'
  if (mf >= ff && mf >= mm) return '男女'
  if (ff >= mm) return '女女'
  return '男男'
}

function inferHeat(entities: WorldEntities, kinkCount: number): HeatLevel {
  const desires = entities.characters.map(c => c.desire).filter((v): v is number => v != null)
  const avg = desires.length ? desires.reduce((a, b) => a + b, 0) / desires.length : 40
  if (kinkCount >= 8 || avg >= 70) return '烈'
  if (kinkCount >= 3 || avg >= 45) return '中'
  return '淡'
}

const WARNING_KEYS: { re: RegExp, tag: string }[] = [
  { re: /强制|非自愿|强迫|noncon/i, tag: '强制' },
  { re: /公开|露出/i, tag: '公开' },
  { re: /多人|3p|群/i, tag: '多人' },
  { re: /捆绑|束缚/i, tag: '捆绑' },
  { re: /训诫|惩罚|打屁股|spank/i, tag: '训诫' },
  { re: /SM|虐/i, tag: 'SM' }
]

function inferTropes(entities: WorldEntities): string[] {
  const tropes = new Set<string>()
  for (const c of entities.characters) {
    for (const rel of c.relationships ?? []) {
      const t = rel.type ?? ''
      if (/师生|老师|学生/.test(t)) tropes.add('师生')
      if (/主从|主奴|主人|奴隶/.test(t)) tropes.add('主从')
      if (/兄|弟|姐|妹|父|母|亲/.test(t)) tropes.add('亲情伦理')
      if (/敌|对手|仇/.test(t)) tropes.add('冤家')
      if (/年下|年长/.test(t)) tropes.add('年下')
      if (/青梅|竹马/.test(t)) tropes.add('青梅竹马')
    }
  }
  return [...tropes].slice(0, 8)
}

function inferSetting(entities: WorldEntities): string {
  const cats = entities.world_rules.map(r => r.category).filter((c): c is string => !!c?.trim())
  const cat = cats.sort((a, b) =>
    cats.filter(x => x === b).length - cats.filter(x => x === a).length
  )[0]
  const loc = [...entities.locations].sort((a, b) => b.mentionCount - a.mentionCount)[0]
  const stage = loc ? (loc.type || loc.name) : ''
  const rule = cat || (entities.world_rules[0]?.rule ? '有特殊规则' : '现实向')
  // 体系类别优先作主语,最高频地点降级为括注:防止现实场景地点(如会所/网吧)靠提及数
  // 顶掉世界类型(如虚拟游戏世界),把舞台误判成现实向
  if (cat) return stage ? `${cat}(${stage})` : cat
  if (stage && rule) return `${stage} + ${rule}`
  return stage || rule || '设定不明'
}

function pickStorySpine(storyline: StoryBeat[]): WorldLocalSummary['storySpine'] {
  if (storyline.length === 0) return []
  const n = storyline.length
  const idx = new Set<number>()
  const at = (ratio: number) => storyline[Math.min(n - 1, Math.max(0, Math.round((n - 1) * ratio)))]?.index
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const i = at(r)
    if (i != null) idx.add(i)
  }
  for (const b of storyline) {
    if (b.turn?.trim()) idx.add(b.index)
  }
  const ordered = storyline.filter(b => idx.has(b.index))
  const picked = ordered.length <= 8
    ? ordered
    : [ordered[0]!, ...ordered.slice(1, -1).filter(b => b.turn?.trim()).slice(0, 6), ordered[ordered.length - 1]!]
        .filter((b, i, arr) => arr.findIndex(x => x.index === b.index) === i)
        .slice(0, 8)
  return picked.map(b => ({ index: b.index, summary: truncate(b.summary, 80) ?? b.summary, turn: b.turn ?? null }))
}

export function summarizeWorldLocal(entities: WorldEntities, storyline: StoryBeat[] = []): WorldLocalSummary {
  const kinkMap = new Map<string, { count: number, views: Record<string, number> }>()
  for (const c of entities.characters) {
    for (const k of c.kinks ?? []) {
      const theme = canonKinkTheme(k.theme)
      if (!theme) continue
      const acc = kinkMap.get(theme) ?? { count: 0, views: {} }
      acc.count++
      const view = (k.view ?? '').trim()
      if (view) acc.views[view] = (acc.views[view] ?? 0) + 1
      kinkMap.set(theme, acc)
    }
  }
  const kinkProfile: KinkProfileEntry[] = [...kinkMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([theme, acc]) => {
      const dominantView = Object.entries(acc.views).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      return { theme, count: acc.count, dominantView }
    })

  const tropes = inferTropes(entities)
  const orientation = inferOrientation(entities)
  const heat = inferHeat(entities, kinkProfile.reduce((s, k) => s + k.count, 0))
  const setting = inferSetting(entities)
  const contentWarnings: string[] = []
  const warningPool = [
    ...kinkProfile.map(k => k.theme),
    ...entities.characters.flatMap(c => (c.kinks ?? []).map(k => k.theme))
  ]
  for (const { re, tag } of WARNING_KEYS) {
    if (warningPool.some(t => re.test(t))) contentWarnings.push(tag)
  }

  const tags = [
    orientation !== '不明' ? orientation : '',
    heat === '烈' ? '高热度' : heat === '淡' ? '淡向' : '',
    ...tropes.slice(0, 4),
    ...kinkProfile.slice(0, 5).map(k => k.theme),
    setting.includes('校园') ? '校园' : '',
    setting.includes('玄幻') || setting.includes('灵') ? '玄幻' : '',
    setting.includes('都市') || setting.includes('现代') ? '现代' : ''
  ].filter(Boolean)
  const uniqTags = [...new Set(tags)].slice(0, 12)

  return {
    tags: uniqTags,
    orientation,
    setting,
    heat,
    contentWarnings: [...new Set(contentWarnings)].slice(0, 8),
    tropes,
    kinkProfile,
    storySpine: pickStorySpine(storyline)
  }
}

function overlayDraftView(local: WorldLocalSummary) {
  return {
    tags: local.tags,
    orientation: local.orientation,
    setting: local.setting,
    heat: local.heat,
    contentWarnings: local.contentWarnings,
    tropes: local.tropes,
    kinkProfile: local.kinkProfile
  }
}

function compactWorldSlice(entities: WorldEntities) {
  const tr = truncate
  return {
    world_rules: [...entities.world_rules]
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, 8)
      .map(r => ({ category: r.category, rule: tr(r.rule, 80) })),
    factions: [...entities.factions]
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, 6)
      .map(f => ({ name: f.name, goal: tr(f.goal, 60), description: tr(f.description, 60) })),
    locations: [...entities.locations]
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, 8)
      .map(l => ({ name: l.name, type: l.type, description: tr(l.description, 60) }))
  }
}

function asStringArray(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()).slice(0, max)
}

/** 把成书模型的高层字段与本地草稿合并(模型只能润色,空则回落草稿) */
export function mergeOverlayMeta(
  raw: Partial<WorldOverlay> | null | undefined,
  local: WorldLocalSummary
): Pick<WorldOverlay, 'tags' | 'orientation' | 'setting' | 'heat' | 'contentWarnings' | 'tropes' | 'kinkProfile'> {
  const tags = asStringArray(raw?.tags, 12)
  const tropes = asStringArray(raw?.tropes, 8)
  const warnings = asStringArray(raw?.contentWarnings, 8)
  const orientation = typeof raw?.orientation === 'string' && ORIENTATIONS.includes(raw.orientation as typeof ORIENTATIONS[number])
    ? raw.orientation
    : local.orientation
  const heat = typeof raw?.heat === 'string' && HEAT_LEVELS.includes(raw.heat as HeatLevel)
    ? raw.heat as HeatLevel
    : local.heat
  const setting = typeof raw?.setting === 'string' && raw.setting.trim()
    ? raw.setting.trim().slice(0, 80)
    : local.setting
  let kinkProfile: KinkProfileEntry[] = []
  if (Array.isArray(raw?.kinkProfile)) {
    kinkProfile = raw.kinkProfile
      .map((k) => {
        if (!k || typeof k !== 'object') return null
        const theme = typeof k.theme === 'string' ? canonKinkTheme(k.theme) : ''
        if (!theme) return null
        const count = typeof k.count === 'number' && Number.isFinite(k.count) ? Math.max(1, Math.round(k.count)) : 1
        const dominantView = typeof k.dominantView === 'string' && k.dominantView.trim() ? k.dominantView.trim() : null
        return { theme, count, dominantView }
      })
      .filter((k): k is KinkProfileEntry => !!k)
      .slice(0, 8)
  }
  return {
    tags: tags.length ? tags : local.tags,
    orientation,
    setting,
    heat,
    contentWarnings: warnings.length ? warnings : local.contentWarnings,
    tropes: tropes.length ? tropes : local.tropes,
    kinkProfile: kinkProfile.length ? kinkProfile : local.kinkProfile
  }
}

/** 名字归一化(去空白;别名消歧与成书角色匹配共用) */
export function normKey(s: string): string {
  return (s ?? '').replace(/\s+/g, '').trim()
}

/** 按章节号从实体库回填引用文本(AI 检查只回章节号,引用以实体 sources 为准) */
export function quoteByChapter(entities: WorldEntities, chapter?: number): EntitySource | null {
  if (!chapter) return null
  for (const list of [
    entities.characters, entities.locations, entities.factions, entities.timeline_events,
    entities.world_rules, entities.items, entities.foreshadowing
  ]) {
    for (const e of list) {
      const s = e.sources.find(s => s.chapter === chapter)
      if (s) return s
    }
  }
  return { chapter }
}

/** 成书后处理:只保留实体库中的角色;first_appearance 缺失时按出现章节兜底 */
export function finalizeCards(
  overlayRaw: { characters?: CharacterCard[] },
  entities: WorldEntities,
  topNames: Set<string>
): CharacterCard[] {
  const nameToEntity = new Map(entities.characters.map(c => [normKey(c.name), c]))
  return (Array.isArray(overlayRaw.characters) ? overlayRaw.characters : [])
    .filter(c => c?.name && topNames.has(c.name))
    .map((c) => {
      // 成书模型偶尔照抄提取输入的别名数组格式:归一化为字符串,与 CharacterCard.alias(string|null) 类型一致
      if (Array.isArray(c.alias)) c = { ...c, alias: c.alias.join('、') || null }
      const ent = nameToEntity.get(normKey(c.name))
      let patched = c
      if (!patched.first_appearance && ent && ent.sources.length > 0) {
        const ch = Math.min(...ent.sources.map(s => s.chapter))
        patched = { ...patched, first_appearance: `第${ch}段` }
      }
      // 成书模型漏填 desire 时,用提取实体里按原文推断的值兜底(比模型自估更贴原文)
      if (patched.desire == null && ent && ent.desire != null) {
        patched = { ...patched, desire: ent.desire }
      }
      // 成书漏填题材喜好时,从提取实体回填原文依据的玩法喜好
      if (!(patched.kinks ?? []).length && ent && (ent.kinks ?? []).length) {
        patched = {
          ...patched,
          kinks: (ent.kinks ?? []).slice(0, 8).map(k => ({
            theme: k.theme,
            view: k.view ?? null,
            role: k.role ?? null,
            detail: k.quote ?? null
          }))
        }
      }
      // 成书漏填性爱属性时,用提取实体里按原文推断的值兜底
      if (!patched.sex && ent && ent.sex && Object.keys(ent.sex).length) {
        patched = { ...patched, sex: { ...ent.sex } }
      }
      // 章节变体:合并阶段生成的按章差异挂到卡上(成书模型不感知)
      if (!(patched.chapterVariants ?? []).length && ent && (ent.chapterVariants ?? []).length) {
        patched = { ...patched, chapterVariants: ent.chapterVariants }
      }
      return patched
    })
}

// ---- 配角独立故事线(角色弧线) ----

/** 弧线生成时注入的角色上限(控制 prompt 体积与 token 成本;超出按出场量取前 N) */
export const ARC_CHARACTER_LIMIT = 10

/** 从主线细纲段收集每个角色的登场段(用于生成候选名单与校验 beatIndex) */
export function characterAppearances(storyline: StoryBeat[] | undefined): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const b of storyline ?? []) {
    for (const name of b.cast ?? []) {
      const key = normKey(name)
      if (!key) continue
      const list = map.get(key) ?? []
      if (!list.includes(b.index)) list.push(b.index)
      map.set(key, list)
    }
  }
  return map
}

/** 弧线 schema(批量与逐条共用,保证产物结构一致) */
const CHARACTER_ARC_SCHEMA = `{
  "arcs": [{
    "character": "角色名(必须与上方人物卡名字一致)",
    "summary": "该角色全书的弧线概述(目标/宿命/处境演变,一两句话)",
    "beats": [{"beatIndex": 0, "summary": "该角色在本段的行动/处境/目标推进(以该角色为中心,80~150字)", "status": "本段处境变化,无则null"}],
    "ending": "该角色在全书终局的状态/结局(null可)"
  }]
}`

/** 弧线候选角色:登场段数 ≥2,按登场段数排序取前 N。
 *  批量提示词与云端 arcs 任务逐条生成共用同一名单,保证两份产物覆盖一致 */
export function characterArcCandidates(
  entities: WorldEntities,
  storyline: StoryBeat[] | undefined
): { card: MergedCharacter, beats: number[] }[] {
  const appearances = characterAppearances(storyline)
  return entities.characters
    .map(c => ({ card: c, beats: appearances.get(normKey(c.name)) ?? [] }))
    .filter(c => c.beats.length >= 2)
    .sort((a, b) => b.beats.length - a.beats.length)
    .slice(0, ARC_CHARACTER_LIMIT)
}

/** 弧线生成请求:基于主线故事线与角色素材,为每个登场且有剧情量的角色生成独立弧线。
 *  增量补生成与成书共用,保证产物一致。输入不含原文正文(避免重复注入),只给细纲 + 人物卡素材。
 *  textWindows 按角色名提供登场段原文节选(可选):批量生成时逐角色注入。 */
export function buildCharacterArcsMessages(
  title: string,
  entities: WorldEntities,
  storyline: StoryBeat[] | undefined,
  textWindows?: Record<string, string>
): { role: 'system' | 'user', content: string }[] {
  const candidates = characterArcCandidates(entities, storyline)
  if (candidates.length === 0) return []
  const beats = [...(storyline ?? [])].sort((a, b) => a.index - b.index)

  const beatLines = beats.map(b => `[段${b.index + 1}] ${b.summary}${b.cast?.length ? `（登场:${b.cast.slice(0, 6).join('、')}）` : ''}`).join('\n')
  const cardLines = candidates.map(({ card, beats: bs }) => {
    const bits = [
      card.identity && `身份:${card.identity}`,
      card.goals?.length ? `目标:${card.goals.slice(0, 4).join('、')}` : '',
      card.fears?.length ? `恐惧/弱点:${card.fears.slice(0, 3).join('、')}` : '',
      card.secrets?.length ? `秘密:${card.secrets.slice(0, 3).join('、')}` : '',
      card.relationships?.length ? `关系:${card.relationships.slice(0, 5).map(r => `${r.name}(${r.type})`).join('、')}` : '',
      bs.length ? `登场段:${bs.map(i => `第${i + 1}段`).join('、')}` : ''
    ].filter(Boolean)
    // chapterVariants 提供该角色在各段的处境变化(比人物卡终态更贴合分段)
    const variantLines = (card.chapterVariants ?? [])
      .filter(v => v.status)
      .slice(0, 20)
      .map(v => `第${(v.stage ?? 0) + 1}段:${v.status}`)
    const win = textWindows?.[card.name]?.trim()
    return `${card.name}:\n${bits.join('\n')}${variantLines.length ? `\n分段处境:\n${variantLines.join('\n')}` : ''}${win ? `\n\n登场段原文节选:\n${win}` : ''}`
  }).join('\n\n')

  return [
    { role: 'system' as const, content: `你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。\n输出结构必须满足:\n${CHARACTER_ARC_SCHEMA}` },
    {
      role: 'user' as const,
      content: `小说《${title}》的主线故事线(按段序)如下:\n${beatLines}\n\n以下角色的人物卡素材(用于生成各自的独立弧线):\n${cardLines}\n\n请为上述每个角色生成一条独立故事线(角色弧线):\n`
        + '- 只能使用上方故事线中已出现且与该角色相关的信息,不得新增原著没有的情节、不得编造该角色的独立事件;\n'
        + '- 每个角色的登场段都已在各自人物卡素材中逐段列出:必须为每一个登场段各生成一条 beat,不得合并多个段、不得省略任何登场段;\n'
        + '- beats 按主线细纲段序对齐(beatIndex 对应段号),只列出该角色实际登场/有戏份的段(未登场段不写);\n'
        + '- summary 以该角色为中心叙述其行动、处境与目标推进,不要重复整段主线剧情;\n'
        + '- 出场信息不足的角色可以省略 beats 或仅给 summary+ending,不要硬凑。'
    }
  ]
}

/** 弧线生成时注入的登场段原文窗口:每段字数上限(取该段 startChar 起的一段正文,忠实还原细节) */
export const ARC_WINDOW_CHARS = 2500
/** 弧线生成时注入的登场段数量上限(取前 N 个登场段,控制输入体积) */
export const ARC_WINDOW_BEAT_LIMIT = 3

/** 单角色弧线请求(arcs 云端任务逐单元调用):只为指定角色生成一条弧线,输入只含该角色素材。
 *  textWindow 为该角色登场段的原文节选(可选):模型据此还原真实细节,不得与原文矛盾。 */
export function buildCharacterArcMessages(
  title: string,
  candidate: { card: MergedCharacter, beats: number[] },
  storyline: StoryBeat[] | undefined,
  textWindow?: string
): { role: 'system' | 'user', content: string }[] {
  const beats = [...(storyline ?? [])].sort((a, b) => a.index - b.index)
  const beatLines = beats.map(b => `[段${b.index + 1}] ${b.summary}${b.cast?.length ? `（登场:${b.cast.slice(0, 6).join('、')}）` : ''}`).join('\n')
  const { card, beats: bs } = candidate
  const bits = [
    card.identity && `身份:${card.identity}`,
    card.goals?.length ? `目标:${card.goals.slice(0, 4).join('、')}` : '',
    card.fears?.length ? `恐惧/弱点:${card.fears.slice(0, 3).join('、')}` : '',
    card.secrets?.length ? `秘密:${card.secrets.slice(0, 3).join('、')}` : '',
    card.relationships?.length ? `关系:${card.relationships.slice(0, 5).map(r => `${r.name}(${r.type})`).join('、')}` : '',
    bs.length ? `登场段:${bs.map(i => `第${i + 1}段`).join('、')}` : ''
  ].filter(Boolean)
  // chapterVariants 提供该角色在各段的处境变化(比人物卡终态更贴合分段)
  const variantLines = (card.chapterVariants ?? [])
    .filter(v => v.status)
    .slice(0, 20)
    .map(v => `第${(v.stage ?? 0) + 1}段:${v.status}`)
  const cardLine = `${card.name}:\n${bits.join('\n')}${variantLines.length ? `\n分段处境:\n${variantLines.join('\n')}` : ''}`
  const windowPart = textWindow?.trim()
    ? `\n\n该角色登场段的原文节选(还原细节用,戏份内容不得与原文矛盾):\n${textWindow.trim()}`
    : ''
  return [
    { role: 'system' as const, content: `你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。\n输出结构必须满足:\n${CHARACTER_ARC_SCHEMA}` },
    {
      role: 'user' as const,
      content: `小说《${title}》的主线故事线(按段序)如下:\n${beatLines}\n\n以下为该角色的人物卡素材:\n${cardLine}${windowPart}\n\n请为该角色生成一条独立故事线(角色弧线):\n`
        + '- 只能使用上方故事线中已出现且与该角色相关的信息,不得新增原著没有的情节、不得编造该角色的独立事件;\n'
        + `- 该角色共登场 ${candidate.beats.length} 段(上方「登场段」已逐段列出):必须为每一个登场段各生成一条 beat(按 beatIndex 对齐),不得合并多个段、不得省略任何登场段;\n`
        + '- beats 按主线细纲段序对齐(beatIndex 对应段号),只列出该角色实际登场/有戏份的段(未登场段不写);\n'
        + '- summary 以该角色为中心叙述其行动、处境与目标推进,不要重复整段主线剧情;\n'
        + '- 出场信息不足可以省略 beats 或仅给 summary+ending,不要硬凑。'
    }
  ]
}

/** 归一化弧线:名字对齐人物卡(normKey)、beatIndex 排序去重、裁剪、只保留有效段 */
export function normalizeCharacterArcs(
  raw: unknown,
  storyline: StoryBeat[] | undefined,
  cards: { name: string }[] | undefined
): CharacterArc[] {
  const beats = (storyline ?? []).map(b => b.index)
  const validIndex = new Set(beats)
  const cardKeys = new Map((cards ?? []).map(c => [normKey(c.name), c.name]))
  const data = (raw as { arcs?: unknown } | null)?.arcs
  if (!Array.isArray(data)) return []
  const out: CharacterArc[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const rawName = String(obj.character ?? '').trim()
    const key = normKey(rawName)
    if (!key) continue
    const name = cardKeys.get(key) ?? rawName
    const arcBeats: CharacterArcBeat[] = []
    if (Array.isArray(obj.beats)) {
      for (const b of obj.beats) {
        if (!b || typeof b !== 'object') continue
        const bo = b as Record<string, unknown>
        const bi = Number(bo.beatIndex)
        if (!Number.isInteger(bi) || !validIndex.has(bi)) continue
        const summary = String(bo.summary ?? '').trim()
        if (!summary) continue
        const status = typeof bo.status === 'string' && bo.status.trim() ? bo.status.trim() : undefined
        arcBeats.push({ beatIndex: bi, summary, status })
      }
    }
    arcBeats.sort((a, b) => a.beatIndex - b.beatIndex)
    const deduped = arcBeats.filter((b, i) => i === 0 || b.beatIndex !== arcBeats[i - 1]!.beatIndex)
    const summary = String(obj.summary ?? '').trim()
    const ending = typeof obj.ending === 'string' && obj.ending.trim() ? obj.ending.trim() : undefined
    if (!summary && deduped.length === 0) continue
    out.push({
      character: name,
      summary: summary || deduped.map(b => `第${b.beatIndex + 1}段:${b.summary}`).join('; ').slice(0, 200),
      beats: deduped,
      ending
    })
  }
  return out
}
