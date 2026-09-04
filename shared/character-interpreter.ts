// shared/character-interpreter.ts
// 保留键解释器(v2):`characters/`(中文保留键) ↔ 引擎语义字段(英文) 的边界适配。
//  - 命中保留键 → 归一后映射到对应语义字段
//  - 其余键 → 全部并入 `profile`(自由区对象)
//  - 值容忍:字符串/数组/对象都接受,数组→必要时合并为文本、字符串→必要时拆数组、null/缺失→空
// 见 docs/format-v2.md §8。
import type { BookCharacter } from './novel-v2'
import type { CharacterCard } from './novel'

// ---- 值容忍工具 ----

/** 标量文本字段归一:字符串去首尾;数组按 '；' 拼;结构化对象取非空字段拼成描述;其余 → null */
export function toText(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim()
    return s || null
  }
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim())
    return parts.length ? parts.join('；') : null
  }
  if (v && typeof v === 'object') {
    const parts: string[] = []
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val == null || val === '') continue
      if (typeof val === 'string') parts.push(`${k}:${val.trim()}`)
      else if (typeof val === 'boolean') parts.push(`${k}:${val ? '是' : '否'}`)
      else if (typeof val === 'number') parts.push(`${k}:${val}`)
    }
    return parts.length ? parts.join('，') : null
  }
  return null
}

/** 列表字段归一:数组过滤字符串;字符串按常见分隔符拆 */
export function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean)
  if (typeof v === 'string') {
    const s = v.trim()
    return s ? s.split(/[、，,;；\n]/).map(x => x.trim()).filter(Boolean) : []
  }
  return []
}

/** 数值归一:数字直接用;字符串可解析;否则 null */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 布尔归一:boolean 直接用;字符串 'true'/'1'/'是' 等 → true */
export function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['true', '1', '是', 'yes'].includes(s)) return true
    if (['false', '0', '否', 'no'].includes(s)) return false
  }
  return null
}

// ---- 中文保留键 → 引擎语义字段 ----

export interface InterpretedCard {
  /** 映射后的引擎语义卡(值已归一) */
  card: CharacterCard
  /** 未识别键 → 自由区(供提示词「补充设定」,见 §8) */
  profile: Record<string, unknown>
}

/** 把 v2 角色卡解释为引擎可用的 CharacterCard + profile */
export function interpretCharacter(raw: BookCharacter): InterpretedCard | undefined {
  const name = typeof raw['姓名'] === 'string' ? raw['姓名'].trim() : ''
  if (!name) return undefined

  const role = (typeof raw['角色'] === 'string' && raw['角色'].trim()) ? raw['角色'].trim() : '配角'
  const personality = toList(raw['性格'])
  const goals = toList(raw['目标'])

  const card: CharacterCard = {
    name,
    role,
    alias: toText(raw['别名']) ?? undefined,
    gender: toText(raw['性别'] ?? raw['身份下性别']) ?? undefined,
    age: toText(raw['年龄']) ?? undefined,
    identity: toText(raw['身份']) ?? undefined,
    appearance: toText(raw['外貌']) ?? undefined,
    personality,
    speech_style: toList(raw['说话风格']),
    background: toText(raw['背景']) ?? undefined,
    abilities: toList(raw['能力']),
    goals,
    fears: toList(raw['恐惧'] ?? raw['弱点']),
    secrets: toList(raw['秘密']),
    first_appearance: toText(raw['首次出场']) ?? undefined,
    dead: toBool(raw['已死亡']) ?? null,
    patience: toNumber(raw['耐心']) ?? null,
    softness: toNumber(raw['心软']) ?? null,
    desire: toNumber(raw['性欲强度']) ?? null
  }

  // 关系:对象=另一人物姓名,值=-100..100亲密度,type 由说明兜底
  if (Array.isArray(raw['关系'])) {
    const rels = raw['关系'].flatMap((r): { name: string, type: string, value: number }[] => {
      if (!r || typeof r !== 'object') return []
      const rel = r as Record<string, unknown>
      const rName = typeof rel['对象'] === 'string' ? rel['对象'].trim() : ''
      if (!rName) return []
      const val = toNumber(rel['值'])
      const desc = typeof rel['说明'] === 'string' ? rel['说明'].trim() : ''
      return [{
        name: rName,
        type: desc || '',
        value: val == null ? 0 : Math.max(-100, Math.min(100, val))
      }]
    })
    if (rels.length) card.relationships = rels
  }

  // 玩法喜好 / 成人属性
  if (Array.isArray(raw['玩法喜好'])) {
    const kinks = raw['玩法喜好'].flatMap((k): { theme: string, view: string | null, role: string | null, detail: string | null }[] => {
      if (!k || typeof k !== 'object') return []
      const kk = k as Record<string, unknown>
      const theme = typeof kk['主题'] === 'string' ? kk['主题'].trim() : ''
      if (!theme) return []
      return [{
        theme,
        view: typeof kk['态度'] === 'string' && kk['态度'].trim() ? kk['态度'].trim() : null,
        role: typeof kk['角色'] === 'string' && kk['角色'].trim() ? kk['角色'].trim() : null,
        detail: typeof kk['细节'] === 'string' && kk['细节'].trim() ? kk['细节'].trim() : null
      }]
    })
    if (kinks.length) card.kinks = kinks
  }
  const sex = raw['成人属性']
  if (sex && typeof sex === 'object') card.sex = sex as CharacterCard['sex']

  // 弧线总结(角色文件内如带 弧线)
  // (弧线现拼/缓存视图,见 §11.1;此处不强行映射,由读取层现拼)

  // 未识别键 → profile(排除已消费保留键,保留弧线整体)
  const consumed = new Set(['姓名', '角色', '身份', '外貌', '性格', '背景', '目标', '关系', '别名', '性别', '年龄', '说话风格', '能力', '恐惧', '弱点', '秘密', '首次出场', '已死亡', '耐心', '心软', '性欲强度', '玩法喜好', '成人属性'])
  const profile: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!consumed.has(k)) profile[k] = v
  }

  return { card, profile }
}

/** 解释整批 v2 角色卡(过滤无姓名者) */
export function interpretCharacters(raws: Record<string, BookCharacter> | BookCharacter[]): InterpretedCard[] {
  const list = Array.isArray(raws) ? raws : Object.values(raws)
  return list.map(interpretCharacter).filter((c): c is InterpretedCard => !!c)
}
