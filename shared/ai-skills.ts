// shared/ai-skills.ts
// AI Skill 玩法库:平台内置 + 用户链接导入的成人题材玩法技能注册表(纯数据,浏览器/服务器共用)。
// 格式与层级对齐市面 agent skill 的实现思路:Skill 本质是"教 AI 怎么做"的 SOP 指南——
//   第一层 Metadata:name/desc/trigger(名称、说明、触发条件:什么场景下启用该玩法)
//   第二层 Body:steps/rules(执行步骤 SOP + 规则与红线)
//   第三层 Resources:references(参考:术语/模板/场景细节,可选)
// 个人中心逐项开/关;开启的技能在游玩时注入叙事提示词,让 AI 按各技能的触发条件与步骤生成回答。
// 兼容旧格式:只有 prompt 字段的老导入文件会自动映射为 steps。
export interface AiSkill {
  /** 稳定标识(存储/开关用;key 为唯一主键) */
  key: string
  /** 玩法名称(界面与提示词展示) */
  name: string
  /** 一句话说明(界面展示) */
  desc: string
  /** Metadata:触发条件——什么场景下使用该玩法(缺省则不限定) */
  trigger?: string
  /** Body:执行步骤 SOP(1、2、3…) */
  steps?: string[]
  /** Body:规则与约束(红线、边界条件) */
  rules?: string[]
  /** Resources:参考资料/术语/模板(可选) */
  references?: string[]
  /** 默认开启(默认 true) */
  defaultOn?: boolean
}

export const AI_SKILLS: AiSkill[] = [
  { key: 'spanking', name: '打屁股', desc: '训诫式责打,轻重与情绪按人物卡把握' },
  { key: 'bondage', name: '捆绑', desc: '绳缚/束缚类限制行动' },
  { key: 'discipline', name: '训诫', desc: '说教式管教与规矩' },
  { key: 'sm', name: 'SM', desc: '支配与服从向互动' },
  { key: 'forced-orgasm', name: '强制高潮', desc: '反复刺激直至失控' },
  { key: 'toy-teasing', name: '小玩具挑逗', desc: '小型玩具的轻慢试探' },
  { key: 'clitoris-suck', name: '阴蒂吮吸', desc: '口舌对敏感点的刺激' },
  { key: 'vibrator-insert', name: '震动棒插入', desc: '震动按摩棒的使用' },
  { key: 'wand-teasing', name: 'AV棒挑逗', desc: '魔力棒等玩具挑逗' },
  { key: 'anal-exam', name: '肛门检查', desc: '身体检查向的侵入玩法' },
  { key: 'anal-temp', name: '量肛温', desc: '体温计等道具玩法' },
  { key: 'spank-needle', name: '打屁股针', desc: '注射向的惩罚与羞耻' },
  { key: 'belt-hands', name: '皮带捆手', desc: '皮带走手部束缚' },
  { key: 'tail-plug', name: '肛塞尾巴', desc: '尾塞与装扮向玩法' },
  { key: 'public-exposure', name: '外出露出', desc: '公共场合的暴露与羞耻' },
  { key: 'bath-sex', name: '浴缸做爱', desc: '浴室/浴缸场景' },
  { key: 'outdoor-sex', name: '野外做爱', desc: '户外场景性爱' },
  { key: 'outdoor-training', name: '野外调教', desc: '户外场景的调教' }
]

/** 按 key 取玩法名;未知 key 原样返回 */
export function aiSkillName(key: string): string {
  return AI_SKILLS.find(s => s.key === key)?.name ?? key
}

/** 把启用的 key 列表转成玩法名列表(过滤未知 key;供叙事提示词使用) */
export function enabledSkillNames(keys: string[]): string[] {
  const set = new Set(keys)
  return AI_SKILLS.filter(s => set.has(s.key)).map(s => s.name)
}

// ---- 校验与规范化(标准 skill 文件:链接导入/粘贴的 JSON) ----

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const it of v) {
    const s = typeof it === 'string' ? it.trim() : ''
    if (s) {
      out.push(s.slice(0, maxLen))
      if (out.length >= maxItems) break
    }
  }
  return out
}

/**
 * 校验并规范化一个标准 skill 文件(三层结构,见 AiSkill 注释)。
 * 必填 key(字母/数字/下划线/连字符)与 name;trigger/steps/rules/references 可部分缺失,
 * 但至少要有执行内容(steps/rules/trigger 其一)。旧格式只有 prompt 时自动映射为 steps。
 * 不合法时抛出带中文说明的 Error。
 */
export function normalizeSkill(raw: unknown): AiSkill {
  const r = (raw ?? {}) as Record<string, unknown>
  const key = str(r.key, 64)
  const name = str(r.name, 40)
  if (!key) throw new Error('技能格式错误:缺少 key(唯一标识)')
  if (!/^[\w-]+$/.test(key)) throw new Error('技能格式错误:key 只能包含字母/数字/下划线/连字符')
  if (!name) throw new Error('技能格式错误:缺少 name(玩法名称)')
  const desc = str(r.desc, 200)
  const trigger = str(r.trigger, 300)
  const steps = strList(r.steps, 8, 300)
  // 旧格式兼容:只有 prompt 的老文件按单步执行内容处理
  if (steps.length === 0) {
    const legacy = str(r.prompt, 2000)
    if (legacy) steps.push(legacy)
  }
  const rules = strList(r.rules, 8, 300)
  const references = strList(r.references, 8, 300)
  if (!steps.length && !rules.length && !trigger) {
    throw new Error('技能内容为空:至少提供 steps / rules / trigger 之一')
  }
  const out: AiSkill = { key, name, desc, defaultOn: r.defaultOn !== false }
  if (trigger) out.trigger = trigger
  if (steps.length) out.steps = steps
  if (rules.length) out.rules = rules
  if (references.length) out.references = references
  return out
}

/** 把一个技能格式化为提示词区块(触发/步骤/规则/参考;供叙事注入) */
export function skillPromptBlocks(skill: AiSkill): string[] {
  const lines: string[] = []
  if (skill.trigger) lines.push(`触发:${skill.trigger}`)
  if (skill.steps?.length) {
    lines.push(`执行步骤:\n${skill.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
  }
  if (skill.rules?.length) {
    lines.push(`规则:\n${skill.rules.map(s => `- ${s}`).join('\n')}`)
  }
  if (skill.references?.length) {
    lines.push(`参考:\n${skill.references.map(s => `- ${s}`).join('\n')}`)
  }
  return lines
}
