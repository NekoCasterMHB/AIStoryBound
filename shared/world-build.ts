// shared/world-build.ts
// 世界观生成流水线的纯函数与提示词(浏览器与服务器共用,零框架依赖):
//   分块 → 提取提示词 → 代码合并(Reduce) → 引用校验 → 一致性检查 → 成书
// 提取/检查/成书的 LLM 调用由浏览器编排,经服务器 /api/ai/chat 中继执行。
import { SEX_TEXT_KEYS, uuid } from './novel'
import type {
  ChapterExtraction, ChapterSegment, CharacterCard, EntityConflict, EntitySource,
  MergedCharacter, WorldEntities
} from './novel'

// ---- 常量 ----

/** 单个提取单元的正文上限(字符,≈17.6K tokens);超长章节/未切块按段落边界切段 */
export const UNIT_MAX_CHARS = 30000
/** 超限长章切段时的相邻段重叠区(字符,≈590 tokens):减少切段边界处实体/关系的遗漏;个人中心高级设置可调,0=关闭 */
export const UNIT_OVERLAP_CHARS = 1000
/** 成书时进入人物卡的角色数上限(按 mentionCount 取前 N) */
export const TOP_CHARACTERS = 12
/** 引用摘录上限(字符) */
export const QUOTE_MAX_CHARS = 80
/** 节约模式:单次提取输出上限(5 类核心实体,引用从简) */
export const ECO_EXTRACT_MAX_TOKENS = 3800
/** 节约模式:单次提取的引用摘录上限(字符) */
export const ECO_QUOTE_MAX_CHARS = 40
/** 节约模式:成书输出上限(只出标题/简介/角色定位,人物卡本地直拼) */
export const ECO_SYNTH_MAX_TOKENS = 800
/** 一致性检查单次输出上限(tokens);个人中心「生成参数-高级设置」可调。默认=主流模型输出上限(384K),等于不限制 */
export const CHECK_MAX_TOKENS = 384000
/** 成书单次输出上限(tokens);个人中心「生成参数-高级设置」可调。默认=主流模型输出上限(384K),等于不限制 */
export const SYNTH_MAX_TOKENS = 384000
/** 平台题材标签:写入生成作品的 overlay.genre,叙事引擎据此知晓题材边界(成人向虚构) */
export const ADULT_GENRE = '成人向'

// ---- 分块 ----

export interface ExtractUnit {
  /** 1-based 章节号(代码据此填 source_chapter,不依赖模型) */
  chapter: number
  /** 展示标签,如 "第3章" / "第3章(段2)" */
  label: string
  content: string
}

/** 章节 → 提取单元:超长章在段落边界切成 ≤maxChars 的段,相邻段保留 overlapChars 重叠(上限可配,默认 UNIT_MAX_CHARS;0=关闭重叠) */
export function splitUnits(chapters: ChapterSegment[], maxChars = UNIT_MAX_CHARS, overlapChars = UNIT_OVERLAP_CHARS): ExtractUnit[] {
  // 重叠区不超过上限一半,保证每次切段都有进展
  const overlap = Math.min(Math.max(0, Math.round(overlapChars)), Math.floor(maxChars / 2))
  const units: ExtractUnit[] = []
  chapters.forEach((ch, i) => {
    const chapterNo = i + 1
    const base = ch.title || `第${chapterNo}部分`
    if (ch.content.length <= maxChars) {
      units.push({ chapter: chapterNo, label: base, content: ch.content })
      return
    }
    // 按 '\n' 边界切段(尽量靠近上限,避免把段落切断);下一段从 cut 回退重叠区起,覆盖切点两侧的上下文
    let rest = ch.content
    let part = 1
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf('\n', maxChars)
      if (cut < maxChars * 0.5) cut = maxChars // 段落过长,硬切
      units.push({ chapter: chapterNo, label: `${base}(段${part})`, content: rest.slice(0, cut).trim() })
      rest = rest.slice(Math.max(0, cut - overlap)).trim()
      part++
    }
    if (rest) units.push({ chapter: chapterNo, label: `${base}(段${part})`, content: rest })
  })
  return units
}

// ---- 提示词 ----

/** 性爱属性 schema 片段(提取用;condom 为布尔三态) */
const SEX_SCHEMA_EXTRACT = '"sex": {"positions": "偏好体位|null","habits": "床笫习惯|null","tease": "语言挑逗风格|null","skill": "性能力技巧|null","member": "性器官大小形状|null","stamina": "持久能力|null","figure": "身材曲线|null","fingers": "手指粗细|null","condom": true|false|null}'

/** 7 类实体提取的 JSON schema(引用逐字、必填字段带 quote) */
export const EXTRACT_SCHEMA_HINT = `{
  "characters": [{"name": "人名(原文用名)","alias": ["别名/称呼"],"gender": "男/女/未知|null","age": "年龄,null 可","identity": "身份职业|null","appearance": "外貌|null","personality": ["性格特征"],"speech_style": ["说话风格"],"background": "背景|null","abilities": ["能力/技能"],"goals": ["目标动机"],"fears": ["恐惧弱点"],"secrets": ["秘密"],"relationships": [{"name": "对方姓名","type": "关系类型","quote": "支持该关系的原文句"}],"dead": true,"desire": "性欲强度 0-100 整数,按原文行为推断,null 可","kinks": [{"theme": "成人题材玩法,如 打屁股/捆绑/训诫/SM/强制高潮 等","view": "喜欢|厌恶|接受|null","role": "承受|施予|双方|null","quote": "支持该喜好的原文句|null"}],${SEX_SCHEMA_EXTRACT},"quote": "本段最能代表该人物的原文句"}],
  "locations": [{"name": "地点名","type": "类别|null","description": "描述|null","notable": ["标志性的人/事/物"],"quote": "原文句"}],
  "factions": [{"name": "势力名","description": "描述|null","goal": "目标|null","members": ["成员名"],"quote": "原文句"}],
  "timeline_events": [{"time": "时间/先后|null","event": "事件概述","characters_involved": ["人物名"],"quote": "原文句"}],
  "world_rules": [{"category": "力量体系/科技/社会规则/自然法则|null","rule": "规则表述","quote": "原文句"}],
  "items": [{"name": "物品名","description": "描述|null","significance": "对剧情的作用|null","quote": "原文句"}],
  "foreshadowing": [{"hint": "伏笔/悬念概述","quote": "原文句"}]
}`

export const JSON_ONLY_SYSTEM = `你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。`

/** 节约模式:只提取 5 类核心实体(去掉 items/foreshadowing),字段说明从简 */
export const EXTRACT_SCHEMA_HINT_ECO = `{
  "characters": [{"name": "人名(原文用名)","alias": ["别名/称呼"],"gender": "男/女/未知|null","age": "年龄|null","identity": "身份|null","appearance": "外貌|null","personality": ["性格特征"],"speech_style": ["说话风格"],"background": "背景|null","abilities": ["能力/技能"],"goals": ["目标"],"fears": ["弱点"],"secrets": ["秘密"],"relationships": [{"name": "对方姓名","type": "关系类型","quote": "支持该关系的原文句"}],"dead": true,"desire": "性欲强度 0-100 整数,null 可","kinks": [{"theme": "成人题材玩法,如 打屁股/捆绑/训诫/SM/强制高潮 等","view": "喜欢|厌恶|接受|null","role": "承受|施予|双方|null","quote": "支持该喜好的原文句|null"}],${SEX_SCHEMA_EXTRACT},"quote": "最能代表该人物的原文句"}],
  "locations": [{"name": "地点名","type": "类别|null","description": "描述|null","notable": ["标志性的人/事/物"],"quote": "原文句"}],
  "factions": [{"name": "势力名","description": "描述|null","goal": "目标|null","members": ["成员名"],"quote": "原文句"}],
  "timeline_events": [{"time": "时间/先后|null","event": "事件概述","characters_involved": ["人物名"],"quote": "原文句"}],
  "world_rules": [{"category": "力量体系/科技/社会规则/自然法则|null","rule": "规则表述","quote": "原文句"}]
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
        + `请提取本段的世界观元素,只输出本段可以证实的信息,按 JSON schema 输出全部 ${eco ? 5 : 7} 类数组(没有则为空数组)。\n`
        + '规则:\n'
        + `1. quote 必须逐字摘录原文原句,最多 ${quoteMax} 字;${eco ? 'characters 与 relationships 必须带 quote,其余尽量带' : 'world_rules / timeline_events / foreshadowing / items / relationships 必须带 quote,其余字段尽量带'}。\n`
        + '2. 只输出有新信息量的条目:仅一闪而过、没有任何可证实信息的角色不要列入;已有信息不要重复罗列。\n'
        + '3. 不确定的字段填 null 或省略,不要编造;人物名用原文用名,别名填 alias。\n'
        + '4. 控制输出篇幅:避免冗余与重复罗列,保持整体输出精简;确保 JSON 完整闭合,不要中途截断。\n'
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
        + `3. 不要编造:所有证据章节号必须来自实体库。\n`
        + `实体库:\n${JSON.stringify(compact)}\n`
        + `代码冲突:\n${JSON.stringify(conflictView)}`
    }
  ]
}

/** 成书:前 TOP_CHARACTERS 名角色紧凑卡 + 统计 + 冲突摘要 → 世界观速览 + 完整人物卡 */
export function buildSynthesizeMessages(title: string, entities: WorldEntities, conflicts: EntityConflict[], warnings: string[]) {
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
  const conflictSummary = conflicts.slice(0, 12).map(c => ({
    entity: `${c.entityType}:${c.entityName}.${c.field}`,
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
    "first_appearance": "首次出现章节,如 第3章(string|null)",
    "dead": true,
    "patience": "耐心 0-100,越小越急躁,null=信息不足",
    "softness": "心软 0-100,越大越心软,null=信息不足",
    "desire": "性欲强度 0-100,越大欲望越强理智越弱,null=信息不足",
    "kinks": [{"theme": "成人题材玩法:打屁股/捆绑/训诫/SM/强制高潮 等(string)","view": "喜欢/厌恶/接受/无感(string|null)","role": "承受/施予/双方(string|null)","detail": "具体表现、反应与敏感度,如 「打屁股反应强烈,轻打即红」(string|null)"}],
    "sex": {"positions": "偏好体位,如 后入/骑乘(string|null)","habits": "床笫习惯/癖好(string|null)","tease": "语言挑逗风格,如 骚话(string|null)","skill": "性能力/技巧(string|null)","member": "性器官大小形状(string|null)","stamina": "持久能力,如 半小时/很快(string|null)","figure": "身材曲线,如 前凸后翘 S 曲线(string|null)","fingers": "手指粗细,如 修长/粗壮(string|null)","condom": "是否戴套 true/false(null=未知)"}
  }]
}`
  return [
    { role: 'system' as const, content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${schema}` },
    {
      role: 'user' as const,
      content: `小说《${title}》的实体库(节选)如下。请生成世界观速览与详细人物卡:\n`
        + '- 只输出下列实体信息的角色,不要新增实体库外的人物;\n'
        + '- 每张卡必须忠实于实体信息,不确定的字段填 null 或空数组,不要编造;\n'
        + `- first_appearance 填最早出现章节(如 "第3章");relationships.value 是 -100~100 的亲密度,依据原文关系定;patience/softness 按实体信息给合理估值,信息不足填 null。\n`
        + `人物信息:\n${JSON.stringify(top)}\n`
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
  "roles": [{"name": "角色名(string,必须是下方列表中的名字)","role": "主角|配角|反派(string)"}]
}`

/** 节约模式成书请求:输入只给头部角色的轻量素材 + 其余实体统计,不带冲突/告警 */
export function buildEcoSynthMessages(title: string, entities: WorldEntities) {
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
  return [
    { role: 'system' as const, content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${ECO_SYNTH_SCHEMA}` },
    {
      role: 'user' as const,
      content: `小说《${title}》的实体库(节选)如下。请给出小说标题、两三句话的世界观简介,并为下列每个角色标注定位:\n`
        + '- roles.name 必须原样使用列表中的名字,不要改名、不要新增列表外人物;\n'
        + '- role 依据出场比重与剧情作用:主角=主要视角人物,反派=与主角对立的主要人物,其余为配角;\n'
        + '- summary 概括世界观特色(题材、舞台、核心矛盾),不要编造实体库外的设定。\n'
        + `人物信息:\n${JSON.stringify(top)}\n`
        + `其余实体统计:\n${JSON.stringify(counts)}`
    }
  ]
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
        identity: c.identity ?? null,
        appearance: c.appearance ?? null,
        personality: c.personality ?? [],
        speech_style: c.speech_style ?? [],
        background: c.background ?? null,
        abilities: c.abilities ?? [],
        goals: c.goals ?? [],
        fears: c.fears ?? [],
        secrets: c.secrets ?? [],
        relationships: (c.relationships ?? []).map(rel => ({ name: rel.name, type: rel.type, value: 0 })),
        first_appearance: firstChapter ? `第${firstChapter}章` : null,
        dead: c.dead ?? null,
        desire: c.desire ?? null,
        kinks: (c.kinks ?? []).slice(0, 8).map(k => ({
          theme: k.theme,
          view: k.view ?? null,
          role: k.role ?? null,
          detail: k.quote ? truncate(k.quote, 60) : null
        })),
        sex: c.sex && Object.keys(c.sex).length ? { ...c.sex } : undefined
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
export function mergeExtractions(units: { chapter: number, extract: ChapterExtraction }[]): { entities: WorldEntities, conflicts: EntityConflict[] } {
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
      acc = { key, displayName, sources: [], mentionCount: 0, scalarSources: {}, entity: make() }
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
      mergeScalar(acc, 'identity', c.identity, src, 'character')
      mergeScalar(acc, 'appearance', c.appearance, src, 'character')
      mergeScalar(acc, 'background', c.background, src, 'character')
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

/** 把实体库中每条 quote 与所在章节原文比对(空白/标点归一化后子串匹配),不匹配标记 verified=false */
export function verifyQuotes(entities: WorldEntities, chapters: ChapterSegment[]): { unverified: number } {
  const texts = new Map<number, string>()
  chapters.forEach((ch, i) => {
    texts.set(i + 1, ch.content)
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
    foreshadowing: Array.isArray(r.foreshadowing) ? r.foreshadowing : []
  }
}

/** 提取全失败时的空占位(合并阶段按 0 实体处理) */
export function emptyExtraction(): ChapterExtraction {
  return { characters: [], locations: [], factions: [], timeline_events: [], world_rules: [], items: [], foreshadowing: [] }
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
      const ent = nameToEntity.get(normKey(c.name))
      let patched = c
      if (!patched.first_appearance && ent && ent.sources.length > 0) {
        const ch = Math.min(...ent.sources.map(s => s.chapter))
        patched = { ...patched, first_appearance: `第${ch}章` }
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
      return patched
    })
}
