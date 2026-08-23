// shared/world-build.ts
// 世界观生成流水线的纯函数与提示词(浏览器与服务器共用,零框架依赖):
//   分块 → 提取提示词 → 代码合并(Reduce) → 引用校验 → 一致性检查 → 成书
// 提取/检查/成书的 LLM 调用由浏览器编排,经服务器 /api/ai/chat 中继执行。
import { uuid } from './novel'
import type {
  ChapterExtraction, ChapterSegment, EntityConflict, EntitySource,
  MergedCharacter, WorldEntities
} from './novel'

// ---- 常量 ----

/** 单个提取单元的正文上限(字符);超长章节/未切块按段落边界切段 */
export const UNIT_MAX_CHARS = 8000
/** 成书时进入人物卡的角色数上限(按 mentionCount 取前 N) */
export const TOP_CHARACTERS = 12
/** 引用摘录上限(字符) */
export const QUOTE_MAX_CHARS = 80

// ---- 分块 ----

export interface ExtractUnit {
  /** 1-based 章节号(代码据此填 source_chapter,不依赖模型) */
  chapter: number
  /** 展示标签,如 "第3章" / "第3章(段2)" */
  label: string
  content: string
}

/** 章节 → 提取单元:超长章在段落边界切成 ≤UNIT_MAX_CHARS 的段 */
export function splitUnits(chapters: ChapterSegment[]): ExtractUnit[] {
  const units: ExtractUnit[] = []
  chapters.forEach((ch, i) => {
    const chapterNo = i + 1
    const base = ch.title || `第${chapterNo}部分`
    if (ch.content.length <= UNIT_MAX_CHARS) {
      units.push({ chapter: chapterNo, label: base, content: ch.content })
      return
    }
    // 按 '\n' 边界切段(尽量靠近上限,避免把段落切断)
    let rest = ch.content
    let part = 1
    while (rest.length > UNIT_MAX_CHARS) {
      let cut = rest.lastIndexOf('\n', UNIT_MAX_CHARS)
      if (cut < UNIT_MAX_CHARS * 0.5) cut = UNIT_MAX_CHARS // 段落过长,硬切
      units.push({ chapter: chapterNo, label: `${base}(段${part})`, content: rest.slice(0, cut).trim() })
      rest = rest.slice(cut).trim()
      part++
    }
    if (rest) units.push({ chapter: chapterNo, label: `${base}(段${part})`, content: rest })
  })
  return units
}

// ---- 提示词 ----

/** 7 类实体提取的 JSON schema(引用逐字、必填字段带 quote) */
export const EXTRACT_SCHEMA_HINT = `{
  "characters": [{"name": "人名(原文用名)","alias": ["别名/称呼"],"gender": "男/女/未知|null","age": "年龄,null 可","identity": "身份职业|null","appearance": "外貌|null","personality": ["性格特征"],"speech_style": ["说话风格"],"background": "背景|null","abilities": ["能力/技能"],"goals": ["目标动机"],"fears": ["恐惧弱点"],"secrets": ["秘密"],"relationships": [{"name": "对方姓名","type": "关系类型","quote": "支持该关系的原文句"}],"dead": true,"quote": "本段最能代表该人物的原文句"}],
  "locations": [{"name": "地点名","type": "类别|null","description": "描述|null","notable": ["标志性的人/事/物"],"quote": "原文句"}],
  "factions": [{"name": "势力名","description": "描述|null","goal": "目标|null","members": ["成员名"],"quote": "原文句"}],
  "timeline_events": [{"time": "时间/先后|null","event": "事件概述","characters_involved": ["人物名"],"quote": "原文句"}],
  "world_rules": [{"category": "力量体系/科技/社会规则/自然法则|null","rule": "规则表述","quote": "原文句"}],
  "items": [{"name": "物品名","description": "描述|null","significance": "对剧情的作用|null","quote": "原文句"}],
  "foreshadowing": [{"hint": "伏笔/悬念概述","quote": "原文句"}]
}`

export const JSON_ONLY_SYSTEM = `你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。`

/** 单单元提取请求消息 */
export function buildExtractMessages(title: string, unit: ExtractUnit) {
  return [
    { role: 'system' as const, content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${EXTRACT_SCHEMA_HINT}` },
    {
      role: 'user' as const,
      content: `小说《${title}》${unit.label}原文如下(<chapter>...</chapter>)。\n`
        + '请提取本段的世界观元素,只输出本段可以证实的信息,按 JSON schema 输出全部 7 类数组(没有则为空数组)。\n'
        + '规则:\n'
        + `1. quote 必须逐字摘录原文原句,最多 ${QUOTE_MAX_CHARS} 字;world_rules / timeline_events / foreshadowing / items / relationships 必须带 quote,其余字段尽量带。\n`
        + '2. 只输出有新信息量的条目:仅一闪而过、没有任何可证实信息的角色不要列入;已有信息不要重复罗列。\n'
        + '3. 不确定的字段填 null 或省略,不要编造;人物名用原文用名,别名填 alias。\n'
        + `<chapter>${unit.content}</chapter>`
    }
  ]
}

/** 一致性检查:输入紧凑实体库 + 代码发现的冲突,输出批注 + 新冲突 */
export function buildCheckMessages(title: string, entities: WorldEntities, conflicts: EntityConflict[]) {
  const compact = compactEntities(entities)
  const conflictView = conflicts.map(c => ({
    id: c.id,
    entity: `${c.entityType}:${c.entityName}`,
    field: c.field,
    valueA: c.valueA,
    valueB: c.valueB,
    evidenceA: c.evidenceA ? { chapter: c.evidenceA.chapter, quote: c.evidenceA.quote } : null,
    evidenceB: c.evidenceB ? { chapter: c.evidenceB.chapter, quote: c.evidenceB.quote } : null
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
    "softness": "心软 0-100,越大越心软,null=信息不足"
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

// ---- Reduce:代码合并(无 LLM) ----

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
  const tr = (s: string | null | undefined, n = 120) => (s && s.length > n ? s.slice(0, n) + '…' : (s ?? null))
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
