// shared/normalize-card.ts
// 外来人物卡 → v2 BookCharacter(中文保留键)的归一化。
//  - 输入:引擎语义卡 CharacterCard(任何来源:本地生成、旧 zip 导入、编辑器保存,见 novel.ts normalizeCharacterCard 的先归一)
//  - 输出:characters/ 目录基础卡(见 docs/format-v2.md §4);未识别键(profile 自由区)原样回写,保证 v2 自由键不丢。
import type { BookCharacter } from './novel-v2'
import type { CharacterCard } from './novel'

/** CharacterCard → BookCharacter(中文保留键;自由区 profile 键原样并入) */
export function characterCardToBook(c: CharacterCard): BookCharacter | undefined {
  if (!c.name?.trim()) return undefined
  const bc: BookCharacter = { 姓名: c.name.trim() }
  if (c.role) bc['角色'] = c.role
  const map = (k: string, v: unknown) => {
    if (v == null) return
    if (typeof v === 'string' && !v.trim()) return
    if (Array.isArray(v) && !v.length) return
    bc[k] = v as never
  }
  map('身份', c.identity)
  map('外貌', c.appearance)
  if (c.personality?.length) bc['性格'] = c.personality
  map('背景', c.background)
  if (c.goals?.length) bc['目标'] = c.goals
  if (c.relationships?.length) bc['关系'] = c.relationships.map(r => ({ 对象: r.name, 值: r.value, 说明: r.type || undefined }))
  if (c.alias) bc['别名'] = [c.alias]
  if (c.speech_style?.length) bc['说话风格'] = c.speech_style
  if (c.abilities?.length) bc['能力'] = c.abilities
  if (c.fears?.length) bc['恐惧'] = c.fears
  if (c.secrets?.length) bc['秘密'] = c.secrets
  if (c.first_appearance) bc['首次出场'] = c.first_appearance
  if (typeof c.dead === 'boolean') bc['已死亡'] = c.dead
  if (typeof c.patience === 'number') bc['耐心'] = c.patience
  if (typeof c.softness === 'number') bc['心软'] = c.softness
  if (typeof c.desire === 'number') bc['性欲强度'] = c.desire
  if (c.kinks?.length) bc['玩法喜好'] = c.kinks.map(k => ({ 主题: k.theme, 态度: k.view ?? undefined, 角色: k.role ?? undefined, 细节: k.detail ?? undefined }))
  if (c.sex) bc['成人属性'] = c.sex as Record<string, unknown>
  // 自由区:profile(读取时未识别键并入,见 v2-convert.bookCharacterToCard)原样回写,不与保留键冲突
  if (c.profile && typeof c.profile === 'object') {
    for (const [k, v] of Object.entries(c.profile)) {
      if (!(k in bc) && v !== undefined) bc[k] = v as never
    }
  }
  return bc
}
