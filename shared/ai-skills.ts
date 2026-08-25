// shared/ai-skills.ts
// AI Skill 玩法库:平台内置 + 用户链接导入的成人题材玩法技能注册表(纯数据,浏览器/服务器共用)。
// 与市面通用 agent skill(SKILL.md)对齐:文件头 YAML frontmatter 声明 name/description,
// frontmatter 之后是自由 Markdown 正文(即"教 AI 怎么做"的 SOP 指引)。
// 个人中心逐项开/关;开启的技能在游玩时原样把正文注入叙事提示词,让 AI 按各技能的指引生成回答。
// 跟随抓取的同级引用文件(reference.md / resources 等)作为附件附在正文后一并注入。
// 兼容读取:IndexedDB 里早期导入的"结构化"旧条目(key/name/desc + steps/rules)仍可渲染,但不再接受新 JSON 导入。
import * as yaml from 'js-yaml'

export interface AiSkill {
  /** 稳定标识(存储/开关用;key 为唯一主键;导入技能由 frontmatter.name 派生) */
  key: string
  /** 玩法名称(界面与提示词展示) */
  name: string
  /** 一句话说明(界面展示;导入技能取自 frontmatter.description) */
  desc: string
  /** 仅兼容旧 IDB 条目:触发条件(新导入技能走 body,不再单独划分) */
  trigger?: string
  /** 仅兼容旧 IDB 条目:执行步骤 SOP */
  steps?: string[]
  /** 仅兼容旧 IDB 条目:规则与约束 */
  rules?: string[]
  /** 仅兼容旧 IDB 条目:参考资料 */
  references?: string[]
  /** 默认开启(默认 true) */
  defaultOn?: boolean
  /** SKILL.md 正文(frontmatter 之后原样);内置玩法与导入技能均携带 */
  body?: string
  /** 跟随抓取的同级引用文件(如 reference.md),注入时附在正文后 */
  attachments?: { name: string, text: string }[]
  /** 导入来源链接(可选,仅记录用途) */
  sourceUrl?: string
}

// ---- 内置玩法 ----
// desc 与 body 均已写好:body 为「触发场景 + 展开步骤 + 规则边界」的简短 SOP,
// 注入叙事时引导模型按人物卡性欲档位/关系设定把握分寸与推进节奏。
export const AI_SKILLS: AiSkill[] = [
  {
    key: 'spanking', name: '打屁股', desc: '训诫式责打,轻重与情绪按人物卡把握',
    body: '触发:训话/管教场景,或角色因违反规矩受罚。\n步骤:1) 先铺陈姿势与心态:被按在膝上或桌边,衣物半褪,露臀拘谨等待。2) 责打从慢到快、从轻到重,穿插数数、说教与身体反应(红痕、扭动、讨饶)。3) 按惩罚进展逐步升级节拍与力度,给台阶认错。4) 收尾以安抚或继续训话结束。\n规则:力度与下数随人物卡性欲档位与关系设定把握;被打者必须能中途开口求饶或喊停,不写成完全麻木。'
  },
  {
    key: 'bondage', name: '捆绑', desc: '绳缚/束缚类限制行动',
    body: '触发:涉及限制行动、绑缚的支配互动。\n步骤:1) 描写绕绳与打结过程,交代每一处的松紧与可活动余量。2) 强调被缚者的试探性挣扎与绳感(勒痕、摩擦)。3) 捆绑后按支配节奏推进其他玩法或单纯维持被困状态。4) 结束时按绳结顺序松绑,处理酸麻与勒痕。\n规则:不描写会导致呼吸困难的颈部环绕勒束;松紧随人物卡耐受度调整,留出喊停余地。'
  },
  {
    key: 'discipline', name: '训诫', desc: '说教式管教与规矩',
    body: '触发:角色违反规矩、顶嘴或需要重申规则时。\n步骤:1) 先抓具体过错,逐条复述因由。2) 定下规矩与惩罚档位,要求复述确认。3) 执行责罚(言语+肢体)并伴随说教,强化规矩的重要性。4) 认错后给安抚与和解,明确此后改过的预期。\n规则:不做羞辱人格的贬低;说教内容贴合人物卡关系(师生/主从/长辈)设定。'
  },
  {
    key: 'sm', name: 'SM', desc: '支配与服从向互动',
    body: '触发:主从/支配向互动中,涉及服从测试、命令与惩罚链的权力游戏。\n步骤:1) 明确双方此刻的支配-服从关系与叫停方式。2) 布置指令并检验执行(命令身体姿态、称谓、动作)。3) 对完成/违抗给予相应奖惩,维持权力落差感。4) 结束时回归平等对话,确认状态与情绪。\n规则:尊重叫停信号,点到即止;服从要求不超过人物卡设定与角色身份的默认尺度。'
  },
  {
    key: 'forced-orgasm', name: '强制高潮', desc: '反复刺激直至失控',
    body: '触发:角色被禁止停下的高刺激反复调教。\n步骤:1) 持续不同方式的刺激使其越过舒适阈值。2) 高潮来临时不停止,继续维持刺激过渡到下一次,描写失控与求饶。3) 连续多波后给喘息或轻微减弱,形成累加。4) 结束以瘫软与脱力收束,事后安抚。\n规则:次数与强度随人物卡性欲档位调整;需要保留可喊停或弱化的空间,不写成完全失禁失控。'
  },
  {
    key: 'toy-teasing', name: '小玩具挑逗', desc: '小型玩具的轻慢试探',
    body: '触发:用小型道具(跳蛋、软毛、羽毛等)做隔衣或轻触挑逗。\n步骤:1) 从外缘/衣物外开始,轻慢逗弄试探反应。2) 观察并描述角色的绷紧、躲闪或迎合。3) 视反应逐步深入或保持隔靴搔痒的磨人节奏。4) 转移阵地或收手制造余韵。\n规则:强度循序渐进;以"磨人"为主,不经同意不骤然加码。'
  },
  {
    key: 'clitoris-suck', name: '阴蒂吮吸', desc: '口舌对敏感点的刺激',
    body: '触发:聚焦敏感点口舌刺激,需要细腻描写。\n步骤:1) 从含弄、舔舐过渡到吸吮,节奏由慢到快。2) 描写吸力变化与反应:腰弓、腿颤、声线变化。3) 在临界点次次收放,拉长前戏。4) 高潮或以停下吊着为收尾。\n规则:贴合人物卡敏感度与性欲档位;避免机械复述,注重反应层次。'
  },
  {
    key: 'vibrator-insert', name: '震动棒插入', desc: '震动按摩棒的使用',
    body: '触发:使用震动按摩棒做插入式互动。\n步骤:1) 先以震动棒在体外试探湿滑与适应。2) 缓缓进入,描写进入过程与体腔内的挤压感。3) 变速/换档配合需要,变换角度。4) 高潮或撤出时缓出,注意拔出的体感反差。\n规则:尺寸与深浅贴合人物卡经验设定;注重扩张不适与快感之间的平衡。'
  },
  {
    key: 'wand-teasing', name: 'AV棒挑逗', desc: '魔力棒等玩具挑逗',
    body: '触发:用魔力棒/AV棒大面积贴放刺激。\n步骤:1) 先在身体表面滑动、试探最敏感位置。2) 贴放固定或小幅打转,靠震动档位操控。3) 反复平移与固定交替,快慢错落。4) 转移部位或持续推进至高潮。\n规则:贴放部位与档位随反应调整;描写重点放在需要伸手去扶的失控感。'
  },
  {
    key: 'anal-exam', name: '肛门检查', desc: '身体检查向的侵入玩法',
    body: '触发:以"检查/体检"为名义的侵入式身体玩法。\n步骤:1) 铺垫姿势与"检查"说辞,营造被审视的羞耻。2) 戴手套/涂润滑,先观察再探入,循序渐进。3) 探入时边检查边评价反应,维持公事公办的腔调。4) 收尾按流程取出、清理,给一句例行评价。\n规则:全程有润滑与渐进;用具与深度贴合谨慎描写,让角色始终可表态不适。'
  },
  {
    key: 'anal-temp', name: '量肛温', desc: '体温计等道具玩法',
    body: '触发:使用体温计等道具做出的羞耻型小玩法。\n步骤:1) 铺垫"测量"目的与姿势要求,强调羞耻感。2) 涂润、缓慢放置,命令夹住保持。3) 等待读数期间维持窘态互动(说话/动作被管束)。4) 取出报数,评价偏高偏低,顺势训话。\n规则:道具描写需安全,时间不宜过长;以羞耻心理为主、物理刺激为辅。'
  },
  {
    key: 'spank-needle', name: '打屁股针', desc: '注射向的惩罚与羞耻',
    body: '触发:以"打针"为名的惩罚/羞耻向玩法。\n步骤:1) 铺垫医嘱/惩罚原因,命令裤袜半褪露出臀位。2) 描写碘伏消毒、拍打肌肉放松、针尖贴皮的紧张。3) 注入时配合说教与安抚,描写绷紧与呼痛。4) 推注完成、按压棉签,收尾叮嘱以后守规矩。\n规则:只做表现性描写,不细写医学操作以免错漏;分寸随人物卡掌握。'
  },
  {
    key: 'belt-hands', name: '皮带捆手', desc: '皮带走手部束缚',
    body: '触发:用皮带束缚双手的支配玩法。\n步骤:1) 让角色交出手腕,描写皮带穿扣与收紧。2) 强调双手被缚后的无力感与身体可控性。3) 借缚手状态引导后续动作或玩法。4) 解缚时检查压痕并安抚。\n规则:松紧以能轻微活动为度,不勒到发麻变色;保留随时可解的说法。'
  },
  {
    key: 'tail-plug', name: '肛塞尾巴', desc: '尾塞与装扮向玩法',
    body: '触发:角色佩戴尾巴装扮、被要求展示装扮,或训话进行中。\n步骤:1) 描写尾巴被安置与戴上的过程,捕捉角色的羞耻与紧绷反应。2) 尾巴随情绪摆动:紧张时夹紧、兴奋时轻摇,作为状态细节反复呈现。3) 训话中要求夹紧尾巴,违规时轻拽尾巴提醒,并口头强调规矩。4) 适时让角色对镜观赏自己的装扮,强化羞耻与依赖感。\n规则:佩戴需充分适应与润滑,以羞耻心理为主;摘除时机由支配方决定,摘除本身可作为奖励环节。'
  },
  {
    key: 'public-exposure', name: '外出露出', desc: '公共场合的暴露与羞耻',
    body: '触发:在公共/半公共场合维持暴露或羞耻装扮的玩法。\n步骤:1) 铺垫外出理由与伪装(裙摆、开口处、裙下机关)。2) 写公共场合的克制:绷紧、怕被发现的姿态与心跳。3) 危险边缘反复试探(经过人群、被注目)。4) 安全返回后的松弛与后怕。\n规则:必须包含合理安全前提(无人察觉/可随时退场);不写真实侵犯他人,保持虚构边界。'
  },
  {
    key: 'bath-sex', name: '浴缸做爱', desc: '浴室/浴缸场景',
    body: '触发:浴室/浴缸场景的亲密互动。\n步骤:1) 铺垫注水、沐浴、雾气与空间狭小感。2) 湿滑水中的抚摸、水声与浮力带来的姿势限制。3) 水面上下交替,水花与呼吸节奏。4) 以浴后擦拭、暧昧收尾。\n规则:结合水景细节;滑倒等意外可作插曲,但别喧宾夺主。'
  },
  {
    key: 'outdoor-sex', name: '野外做爱', desc: '户外场景性爱',
    body: '触发:户外场景的性爱互动。\n步骤:1) 铺垫地点与私密性、被发现的风险。2) 借助地形(树干/草地/岩石)描写姿势与摩擦。3) 穿插风声、光线、怕暴露的紧张。4) 事后整理衣物、检查痕迹,仓皇或满足地收束。\n规则:地点必须私密可行,维持"仅有彼此"的边界,不做真实旁观者描写。'
  },
  {
    key: 'outdoor-training', name: '野外调教', desc: '户外场景的调教',
    body: '触发:户外场景中的调教玩法(命令、服从、暴露训练)。\n步骤:1) 选定半隐蔽场地,交代规则与口令。2) 布置服从任务(固定姿态、等待、夹紧等)并监督。3) 用周围环境(路人声、风声)制造紧张与羞耻。4) 终结时收束回安全点,总结表现与奖惩。\n规则:以"在场无人察觉"为安全前提;命令不超人物卡身份与耐受尺度。'
  }
]

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
    body,
    defaultOn: true
  }
}

/** 抽取 SKILL.md 正文里的同级文件引用:相对路径 Markdown 链接 + Anthropic 约定 $SKILL_FOLDER$/路径 */
export function extractSkillRefs(markdown: string): string[] {
  const out: string[] = []
  const push = (p: string) => {
    let clean = p.trim().split(/[?#]/)[0] ?? ''
    clean = clean.replace(/[.,;:!?。，；：、)）\]》"'`』」]+$/g, '') // 去掉句尾标点(如「extra.txt。」)
    if (!clean) return
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(clean)) return // 绝对 URL / 协议链接
    if (/^(#|mailto:|data:|javascript:|tel:)/i.test(clean)) return
    if (/\.(png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|eot|zip|gz|tar|pdf|mp4|mp3|wav|exe|jar)([?#].*)?$/i.test(clean)) return // 图片/二进制
    if (!/\.(md|markdown|txt)([?#].*)?$/i.test(clean)) return // 只收文本型文档
    out.push(clean)
  }
  // [label](./reference.md)
  for (const m of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const p = m[1] ?? ''
    if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(p)) push(p)
  }
  // $SKILL_FOLDER$/reference.md
  for (const m of markdown.matchAll(/\$SKILL_FOLDER\$\/([^\s`"']+)/g)) {
    push(m[1] ?? '')
  }
  return [...new Set(out)]
}

/** 把相对路径拼到主文件 URL 上(目录级解析),非法返回 null */
export function resolveSkillRefUrl(base: string, rel: string): string | null {
  try {
    const u = new URL(rel, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch {
    return null
  }
}

/** 把一个技能格式化为提示词区块(优先原样正文;旧条目按结构化字段渲染) */
export function skillPromptBlocks(skill: AiSkill): string[] {
  if (skill.body) {
    const blocks = [`正文:\n${skill.body}`]
    for (const a of skill.attachments ?? []) {
      if (a.text.trim()) blocks.push(`参考文件:${a.name}\n${a.text}`)
    }
    return blocks
  }
  // 兼容 IndexedDB 里早期导入的结构化旧条目
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
