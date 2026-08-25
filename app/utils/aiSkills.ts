// app/utils/aiSkills.ts
// 「AI Skill 玩法库」本地偏好:
//  - 开启状态存 localStorage(键=技能 key,内置与用户导入共用同一份开关列表)
//  - 通过链接导入的自定义技能(标准 skill JSON)存 IndexedDB(ai-skills 仓库,keyPath=key)
// 开启的技能(含详细玩法设定 prompt)注入游玩叙事提示词作为可用玩法菜单。
import { AI_SKILLS } from '#shared/ai-skills'
import type { AiSkill } from '#shared/ai-skills'
import { db } from './localDb'

const STORE_SKILLS = 'ai-skills'
const KEY = 'ai-skills-enabled-v1'

/** 内置默认开启项(从未设置过开关时的兜底) */
function defaultKeys(): string[] {
  return AI_SKILLS.filter(s => s.defaultOn !== false).map(s => s.key)
}

/** 读取当前启用的技能 key 列表;未设置过时返回内置默认开启项,设置过则原样(可为空=全部关闭) */
export function loadEnabledAiSkills(): string[] {
  if (typeof localStorage === 'undefined') return defaultKeys()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== null) {
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr)) {
        // 只做字符串清洗,不过滤未知 key(用户导入技能也在同一列表里)
        return [...new Set(arr.filter(k => typeof k === 'string'))] as string[]
      }
    }
  } catch {
    // 数据损坏按默认处理
  }
  return defaultKeys()
}

/** 保存启用的技能 key 列表(空数组 = 全部关闭,显式落盘,重启不反弹) */
export function saveEnabledAiSkills(keys: string[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify([...new Set(keys.filter(k => typeof k === 'string'))]))
}

// ---- 用户导入的自定义技能(IndexedDB) ----

/** 全部用户导入技能(无则空数组;环境不支持 IDB 时返回空) */
export async function getUserSkills(): Promise<AiSkill[]> {
  if (typeof indexedDB === 'undefined') return []
  const d = await db()
  return (await d.getAll(STORE_SKILLS)) as AiSkill[]
}

/** 按 key 读取单个用户技能(不存在返回 null) */
export async function getUserSkill(key: string): Promise<AiSkill | null> {
  if (typeof indexedDB === 'undefined') return null
  const d = await db()
  return ((await d.get(STORE_SKILLS, key)) as AiSkill | undefined) ?? null
}

/** 保存/覆盖一个用户技能(key 冲突时覆盖) */
export async function saveUserSkill(skill: AiSkill): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.put(STORE_SKILLS, JSON.parse(JSON.stringify(skill)))
}

/** 删除用户技能,并把它从启用列表里移除 */
export async function deleteUserSkill(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.delete(STORE_SKILLS, key)
  saveEnabledAiSkills(loadEnabledAiSkills().filter(k => k !== key))
}

/** 当前启用的技能对象列表(内置 + 用户导入,叙事提示词用) */
export async function loadEnabledAiSkillObjects(): Promise<AiSkill[]> {
  const set = new Set(loadEnabledAiSkills())
  const list: AiSkill[] = AI_SKILLS.filter(s => set.has(s.key))
  const users = await getUserSkills()
  for (const u of users) {
    if (set.has(u.key)) list.push(u)
  }
  return list
}
