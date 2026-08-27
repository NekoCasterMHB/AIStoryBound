// shared/ai-skills.ts
// AI Skill 玩法库注册表(浏览器/服务器共用,纯数据 + SKILL.md 解析)。
// 技能来源为 Skill 商城:下载后解析 SKILL.md(frontmatter 声明 name/description +
// 自由 Markdown 正文,即"教 AI 怎么做"的 SOP 指引)注册到本地,逐项开关;
// 开启的技能在游玩时原样把正文注入叙事提示词,让 AI 按各技能的指引生成回答。
// 历史遗留:内置玩法与链接导入、旧结构化条目(trigger/steps/rules)已废弃,不再兼容读取。
import * as yaml from 'js-yaml'

export interface AiSkill {
  /** 稳定标识(存储/开关用;key 为唯一主键;商城技能取商品 id) */
  key: string
  /** 玩法名称(界面与提示词展示) */
  name: string
  /** 一句话说明(界面展示;取自 frontmatter.description) */
  desc: string
  /** SKILL.md 正文(frontmatter 之后原样) */
  body: string
  /** 包内随附的同级引用文件(如 reference.md),注入时附在正文后 */
  attachments?: { name: string, text: string }[]
  /** 本地安装的商城版本号(有商城来源时记录,用于与商城最新版本对比提示更新) */
  storeVersion?: number
}

// ---- SKILL.md 解析(frontmatter + 正文)→ AiSkill ----

/** 从 SKILL.md 文本切出 YAML frontmatter 与正文;没有 frontmatter 返回 null */
function splitFrontmatter(text: string): { meta: string, body: string } | null {
  const src = text.replace(/^\uFEFF/, '')
  // 容忍前导空白/空行;闭包 `---` 取第一处,与 frontmatter 约定一致
  const m = /^[ \t\r\n]*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!m) return null
  return { meta: m[1] ?? '', body: src.slice(m.index + m[0].length) }
}

/** 由名称派生稳定 key:保留字母/数字(含中文),其余转连字符 */
function slugifyKey(name: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return key || 'skill'
}

/**
 * 解析一份市面通用 SKILL.md(frontmatter 声明 name/description + 自由 Markdown 正文)。
 * 必填 name 与 description(缺失报中文错误);key 由 name 派生;正文非空校验。
 * 不合法时抛出带中文说明的 Error。
 */
export function parseSkillMd(text: string): AiSkill {
  const split = splitFrontmatter(text)
  if (!split) {
    throw new Error('不是有效的 Skill 文件:缺少 YAML frontmatter(文件开头需 --- 包裹的 name/description)')
  }
  let meta: Record<string, unknown>
  try {
    const parsed = yaml.load(split.meta || '')
    meta = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  } catch {
    throw new Error('Skill 文件 frontmatter 不是合法 YAML,请检查格式')
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (!name) throw new Error('Skill 文件缺少 name(frontmatter 必填)')
  if (!description) throw new Error('Skill 文件缺少 description(frontmatter 必填)')
  const body = split.body.trim()
  if (!body) throw new Error('Skill 文件正文为空:请在 frontmatter 之后写清玩法指引')
  return {
    key: slugifyKey(name),
    name,
    desc: description.slice(0, 200),
    body
  }
}

/** 从 SKILL.md 正文剥离「示例」章节:示例是具体场景与人设(会污染当前小说的世界观并浪费 token),
 *  注入时仅保留触发场景/执行步骤/强度进阶/规则等可执行指引;匹配 `### 示例` 标题行开始,到下一个任意标题行结束 */
export function stripSkillExamples(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let skip = false
  for (const line of lines) {
    if (/^#{1,6}\s*示例/.test(line.trimStart())) {
      skip = true
      continue
    }
    if (skip && /^#{1,6}\s/.test(line.trimStart())) skip = false
    if (!skip) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 把一个技能格式化为提示词区块(正文剥离示例章节 + 随附参考文件) */
export function skillPromptBlocks(skill: AiSkill): string[] {
  const blocks = [`正文:\n${stripSkillExamples(skill.body)}`]
  for (const a of skill.attachments ?? []) {
    if (a.text.trim()) blocks.push(`参考文件:${a.name}\n${a.text}`)
  }
  return blocks
}
