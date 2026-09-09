// shared/normalize-card.ts
// 外来人物卡 → v2 BookCharacter(中文保留键)的归一化。
//  - 输入:引擎语义卡 CharacterCard(任何来源:本地生成、旧 zip 导入、编辑器保存,见 novel.ts normalizeCharacterCard 的先归一)
//  - 输出:characters/ 目录基础卡(见 docs/format-v2.md §4);未识别键(profile 自由区)原样回写,保证 v2 自由键不丢。
import type { BookCharacter } from './novel-v2'
import type { CharacterCard } from './novel'

/** 「未知」值清洗:AI 对无法判断的属性返回「未知」,落卡时不写入(空值由 map 跳过)。
 *  字符串全等「未知」→ 剔除;数组剔除「未知」项(空了剔除整个);对象递归剔除值为「未知」的键(空对象剔除)。 */
function cleanUnknown(v: unknown): unknown {
  if (typeof v === 'string') return v.trim() === '未知' ? undefined : v
  if (Array.isArray(v)) {
    const arr = v.filter(x => !(typeof x === 'string' && x.trim() === '未知')).map(x => (x && typeof x === 'object' ? cleanUnknown(x) : x))
    return arr.length ? arr : undefined
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const cleaned = cleanUnknown(val)
      if (cleaned !== undefined) out[k] = cleaned
    }
    return Object.keys(out).length ? out : undefined
  }
  return v
}

/** CharacterCard → BookCharacter(中文保留键;自由区 profile 键原样并入) */
export function characterCardToBook(c: CharacterCard): BookCharacter | undefined {
  if (!c.name?.trim()) return undefined
  const bc: BookCharacter = { 姓名: c.name.trim() }
  if (c.role) bc['角色'] = c.role
  const map = (k: string, v: unknown) => {
    v = cleanUnknown(v)
    if (v == null) return
    if (typeof v === 'string' && !v.trim()) return
    if (Array.isArray(v) && !v.length) return
    bc[k] = v as never
  }
  map('身份', c.identity)
  // 性别/年龄:解释器读卡时消费为引擎字段,写回必须同样映射,否则编辑保存后这两项从 v2 卡上丢失
  // (「未知」由 cleanUnknown 统一剔除,无需单独判断)
  map('性别', c.gender)
  map('年龄', c.age)
  map('外貌', c.appearance)
  if (c.personality?.length) bc['性格'] = c.personality
  map('背景', c.background)
  if (c.goals?.length) bc['目标'] = c.goals
  if (c.relationships?.length) bc['关系'] = c.relationships.map(r => ({ 对象: r.name, 值: r.value, 说明: r.type || undefined }))
  // 别名:读侧 toText 把数组按「;」连接为字符串,写回对称拆分还原数组(多别名不丢)
  if (c.alias) {
    const aliases = c.alias.split(/[；;]/).map(s => s.trim()).filter(Boolean)
    if (aliases.length) bc['别名'] = aliases
  }
  if (c.speech_style?.length) bc['说话风格'] = c.speech_style
  if (c.abilities?.length) bc['能力'] = c.abilities
  if (c.fears?.length) bc['恐惧'] = c.fears
  if (c.secrets?.length) bc['秘密'] = c.secrets
  if (c.first_appearance) bc['首次出场'] = c.first_appearance
  // 基础卡不落「已死亡」:死亡是剧情发展到某段才发生的,只以段状态/局内动态状态表达(game.ts applySegmentCharacter / dyn 补丁)
  if (typeof c.patience === 'number') bc['耐心'] = c.patience
  if (typeof c.softness === 'number') bc['心软'] = c.softness
  if (typeof c.desire === 'number') bc['性欲强度'] = c.desire
  if (c.kinks?.length) {
    bc['玩法喜好'] = c.kinks.map((k): Record<string, unknown> => {
      const base: Record<string, unknown> = {
        主题: k.theme,
        ...(k.view != null ? { 态度: k.view } : {}),
        ...(k.role != null ? { 角色: k.role } : {}),
        ...(k.detail != null ? { 细节: k.detail } : {})
      }
      // 归一四键之外的扩展键原样保留(来源方自定义字段,往返不丢)
      const known = new Set(['theme', 'view', 'role', 'detail'])
      for (const [k2, v2] of Object.entries(k as Record<string, unknown>)) {
        if (!known.has(k2) && v2 !== undefined) base[k2] = v2
      }
      return base
    }) as BookCharacter['玩法喜好']
  }
  // 自由区:profile(读取时未识别键并入)原样回写,不与保留键冲突;
  // 先取出再并入——cleanUnknown 是「未知=空」的语义清洗,不应触及用户自由键的任意取值
  const profileEntries = Object.entries(c.profile && typeof c.profile === 'object' ? c.profile : {})
  if (c.sex) bc['成人属性'] = c.sex as Record<string, unknown>
  // 统一「未知」清洗:AI 返回「未知」的属性(含数组项/对象内嵌键)不落卡;
  // 姓名除外(是卡的身份键,即使恰好叫「未知」也保留)
  const cleaned = cleanUnknown(bc) as BookCharacter | undefined
  if (!cleaned) return undefined
  for (const [k, v] of profileEntries) {
    if (!(k in cleaned) && v !== undefined) cleaned[k] = v as never
  }
  return { ...cleaned, 姓名: bc['姓名'] }
}
