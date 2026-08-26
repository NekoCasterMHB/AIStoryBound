// app/utils/aiSkills.ts
// 「AI Skill 玩法库」本地注册表:
//  - 技能来源为 Skill 商城:下载 zip → 解析 SKILL.md → 注册进 IndexedDB(ai-skills 仓库,key=商城商品 id),下载后自动启用;
//  - 开启状态存 localStorage(键=skill key,与已安装列表共用一份开关);
//  - 开启的技能(含详细玩法设定 prompt)注入游玩叙事提示词作为可用玩法菜单。
// 历史遗留:内置玩法、链接导入与旧结构化条目(trigger/steps/rules)已废弃,不再兼容读取。
import { unzipSync } from 'fflate'
import { parseSkillZip } from '#shared/store-skill'
import { parseSkillMd } from '#shared/ai-skills'
import type { AiSkill } from '#shared/ai-skills'
import { db } from './localDb'

const STORE_SKILLS = 'ai-skills'
const KEY = 'ai-skills-enabled-v1'

/** 读取当前启用的技能 key 列表;未设置过时为 [] (全部关闭) */
export function loadEnabledAiSkills(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== null) {
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr)) {
        return [...new Set(arr.filter(k => typeof k === 'string'))] as string[]
      }
    }
  } catch {
    // 数据损坏按默认处理
  }
  return []
}

/** 保存启用的技能 key 列表(空数组 = 全部关闭,显式落盘,重启不反弹) */
export function saveEnabledAiSkills(keys: string[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify([...new Set(keys.filter(k => typeof k === 'string'))]))
}

// ---- 已下载技能注册表(IndexedDB,key = 商城商品 id) ----

/** 全部本地条目(含老格式残留,一般不直接使用) */
export async function getUserSkills(): Promise<AiSkill[]> {
  if (typeof indexedDB === 'undefined') return []
  const d = await db()
  return (await d.getAll(STORE_SKILLS)) as AiSkill[]
}

/** 已下载技能列表(仅新版格式:带 SKILL.md 正文;旧结构化条目不再兼容展示/加载) */
export async function listInstalledSkills(): Promise<AiSkill[]> {
  const rows = await getUserSkills()
  return rows.filter(s => typeof s.body === 'string' && s.body.length > 0)
}

/** 按 key 读取单个技能(不存在返回 null) */
export async function getUserSkill(key: string): Promise<AiSkill | null> {
  if (typeof indexedDB === 'undefined') return null
  const d = await db()
  return ((await d.get(STORE_SKILLS, key)) as AiSkill | undefined) ?? null
}

/** 保存/覆盖一个技能(key 冲突时覆盖) */
export async function saveUserSkill(skill: AiSkill): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.put(STORE_SKILLS, JSON.parse(JSON.stringify(skill)))
}

/** 删除本地技能副本,并把它从启用列表里移除 */
export async function deleteUserSkill(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.delete(STORE_SKILLS, key)
  saveEnabledAiSkills(loadEnabledAiSkills().filter(k => k !== key))
}

/**
 * 从商城下载的 zip 安装技能:校验格式(必备 SKILL.md)→ 解析 frontmatter 与正文 →
 * 随附小文本文件作为参考附件 → 注册本地(同名覆盖=更新版本)→ 自动启用。
 * version 为商城版本号、storeName 为商城展示名(随本地记录保存:本地记录名以商城为准,
 * 版本更新导致改名后也能同步;不传则用 SKILL.md 内名称)。
 * 失败抛出带中文说明的 Error,调用方提示用户。
 */
export async function installStoreSkillZip(zip: Uint8Array, storeId: string, version?: number, storeName?: string): Promise<AiSkill> {
  // 校验压缩包结构与 SKILL.md 存在(不合规抛错),并取出 SKILL.md 文本
  const parsed = parseSkillZip(zip)
  const skill = parseSkillMd(parsed.skillMd ?? '')
  skill.key = storeId
  if (typeof version === 'number') skill.storeVersion = version
  if (storeName?.trim()) skill.name = storeName.trim()

  // 随附文件:SKILL.md 之外的小文本文件(单文件上限 200KB,最多 20 个)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zip)
  } catch {
    files = {}
  }
  const attachments: { name: string, text: string }[] = []
  for (const [name, buf] of Object.entries(files)) {
    if (/SKILL\.md$/i.test(name) || name.endsWith('/') || buf.length === 0) continue
    if (buf.length > 200 * 1024) continue
    attachments.push({ name, text: new TextDecoder().decode(buf) })
    if (attachments.length >= 20) break
  }
  if (attachments.length) skill.attachments = attachments

  await saveUserSkill(skill)
  // 下载后自动启用:追加到现有启用列表,去重
  saveEnabledAiSkills([...new Set([...loadEnabledAiSkills(), storeId])])
  return skill
}

/** 当前启用的技能对象列表(叙事提示词用);仅统计已安装的新版技能 */
export async function loadEnabledAiSkillObjects(): Promise<AiSkill[]> {
  const set = new Set(loadEnabledAiSkills())
  return (await listInstalledSkills()).filter(s => set.has(s.key))
}
