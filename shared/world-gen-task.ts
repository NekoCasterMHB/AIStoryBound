// shared/world-gen-task.ts
// 云端世界生成任务的共享类型与估算(前后端共用):
//  - 任务 DTO(客户端轮询 /api/world-gen/tasks 的返回结构)
//  - 缓存命中信息(相同 txt 二次上传时的「拉取 / 重新生成」选择)
//  - token 预估(原 app/utils/tokenQuota 的流水线建模,服务端预授权与客户端预检共用同一口径)
import { CJK_TOKEN_PER_CHAR } from './token-estimate'
import { DEFAULT_GEN_LIMITS } from './gen-limits'
import type { GenLimits } from './gen-limits'
import { ARC_CHARACTER_LIMIT } from './world-build'

/** full=完整(提取+检查+AI成书)| eco=节约(无检查,人物卡本地直拼)| custom=按步骤开关自定义 */
export type WorldGenMode = 'full' | 'eco' | 'custom'

/**
 * 自定义模式的步骤开关(full/eco 不使用;缺省全开)。
 * 开关配置仅存浏览器本地 localStorage,发起任务时作为参数上传,任务行 payload 里持久化。
 */
export interface WorldGenStepSwitches {
  /** 作者识别(正文/文件名正则未命中时的 AI 检索) */
  author: boolean
  /** 一致性检查(AI 逐冲突裁决) */
  check: boolean
  /** 人物卡 AI 润色(完整成书;关闭=轻量成书+本地直拼朴素卡) */
  synth: boolean
  /** 配角故事线(逐角色生成独立弧线) */
  arcs: boolean
}

/** 自定义模式开关缺省值:全开 = 与完整模式一致 */
export const DEFAULT_STEP_SWITCHES: WorldGenStepSwitches = {
  author: true,
  check: true,
  synth: true,
  arcs: true
}

/** 任务行 payload JSON → 步骤开关;非法/缺失回退全开 */
export function parseWorldGenSteps(payload: string | null | undefined): WorldGenStepSwitches {
  if (!payload) return { ...DEFAULT_STEP_SWITCHES }
  try {
    const raw = JSON.parse(payload) as Partial<WorldGenStepSwitches> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STEP_SWITCHES }
    return {
      author: typeof raw.author === 'boolean' ? raw.author : DEFAULT_STEP_SWITCHES.author,
      check: typeof raw.check === 'boolean' ? raw.check : DEFAULT_STEP_SWITCHES.check,
      synth: typeof raw.synth === 'boolean' ? raw.synth : DEFAULT_STEP_SWITCHES.synth,
      arcs: typeof raw.arcs === 'boolean' ? raw.arcs : DEFAULT_STEP_SWITCHES.arcs
    }
  } catch {
    return { ...DEFAULT_STEP_SWITCHES }
  }
}

export type WorldGenTaskStatus = 'uploaded' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

/** 管线阶段(与 app/utils/worldGen.ts 的 GenerateProgress.stage 对齐,复用生成页 stepper)
 *  arcs=补充配角故事线任务(按候选角色逐条生成,stageDetail 记录 doneUnits/totalUnits) */
export type WorldGenStage = 'parse' | 'author' | 'extract' | 'merge' | 'check' | 'synthesize' | 'arcs' | 'done'

/** 任务类型:world=整书世界生成 | arcs=补充生成配角故事线 */
export type WorldGenTaskKind = 'world' | 'arcs'

/** key 来源:platform=平台 key 预授权计费 | user=用户自建 key(云端加密暂存,零扣费) */
export type WorldGenKeySource = 'platform' | 'user'

/** extract/arcs 阶段进度明细(stage_detail JSON) */
export interface WorldGenStageDetail {
  doneUnits: number
  totalUnits: number
}

/** 任务 DTO(GET /api/world-gen/tasks 与 /:id 返回;不含 key 密文等敏感列) */
export interface WorldGenTaskDTO {
  id: string
  kind: WorldGenTaskKind
  /** arcs 任务绑定的本地作品 id;world 任务为 null */
  sourceWorkId: string | null
  status: WorldGenTaskStatus
  stage: WorldGenStage
  stageDetail: WorldGenStageDetail
  sourceHash: string
  fileSize: number
  title: string | null
  author: string | null
  mode: WorldGenMode
  keySource: WorldGenKeySource
  estimatedTokens: number
  tokensUsed: number
  error: string | null
  warnings: string[]
  createdAt: string
  updatedAt: string
  /** completed 任务可下载的 zip 地址(相对路径) */
  downloadUrl?: string
  /** 拉取自共享缓存的任务无此标记;首次生成的任务为 true */
  generated?: boolean
}

/** 缓存命中信息(POST /api/world-gen/check 返回) */
export interface WorldCacheHit {
  cacheId: string
  sourceHash: string
  title: string | null
  author: string | null
  mode: WorldGenMode
  tokensUsed: number
  /** 拉取所需 token = floor(tokensUsed / 2) */
  halfCost: number
  createdAt: string
}

// ---- 流水线 token 估算(与 shared/world-build 的真实请求结构对应;按实测消耗校准,宁高勿低) ----
/** 每提取单元:系统 schema + 指令的输入开销(tokens;实测 schema+规则 ≈ 900 汉字当量 ≈ 700 token,取整留余) */
const EXTRACT_INPUT_OVERHEAD_TOKENS = 1000
/** 每提取单元:典型提取 JSON 输出(tokens;10K 字单元通常产出 3~8 角色 + 各类实体,≈ 1500~2500) */
const EXTRACT_OUTPUT_TOKENS = 2200
/** 节约模式每提取单元输出:5 类实体 + 情节细纲、引用从简 */
const ECO_EXTRACT_OUTPUT_TOKENS = 900
/** 一致性检查输入:紧凑实体库 ≈ 全书 token 数的该比例(去 quote、值截断,实体量随书长亚线性) */
const CHECK_INPUT_TOKEN_RATIO = 0.10
/** 一致性检查:指令输入开销 + 输出(tokens;输出为逐条批注 JSON,通常数百) */
const CHECK_INPUT_OVERHEAD_TOKENS = 1000
const CHECK_OUTPUT_TOKENS = 1500
/** 成书输入:头部角色卡 + 世界节选 + 故事骨干 ≈ 全书 token 数的该比例(输入有界,不随书长线性涨) */
const SYNTH_INPUT_TOKEN_RATIO = 0.10
/** 成书:指令输入开销(tokens) */
const SYNTH_INPUT_OVERHEAD_TOKENS = 1000
/** 完整模式成书输出:TOP_CHARACTERS 张详细人物卡 + 标题/简介 */
const SYNTH_OUTPUT_TOKENS = 5000
/** 节约模式成书输入更轻(只带头部角色轻量素材) */
const ECO_SYNTH_INPUT_TOKEN_RATIO = 0.06
/** 节约模式成书输出:标题/简介/角色定位 + 标签/性向/设定 */
const ECO_SYNTH_OUTPUT_TOKENS = 800
/** 作者识别(正文抽样输入 + 未命中时联网检索,输出极少) */
const AUTHOR_TOKENS = 1200
/** 配角故事线:每候选角色的输入开销(tokens;主线 beats 节选 + 角色素材 + 登场段原文窗口 3×2500 字) */
const ARCS_UNIT_INPUT_TOKENS = 4000
/** 配角故事线:每候选角色的典型输出(tokens;单条独立弧线 JSON,覆盖全部登场段) */
const ARCS_UNIT_OUTPUT_TOKENS = 1500
/** 配角故事线候选数量:登场 2 段以上角色数,按全书规模估算(有界于 ARC_CHARACTER_LIMIT;登场角色随书长亚线性) */
function arcsCandidateCount(totalChars: number): number {
  // 粗模型:约每 4000 字一个登场角色,候选 ≈ 登场角色的一半(登场≥2 段),封顶 10
  const candidates = Math.max(1, Math.round(totalChars / 4000 / 2))
  return Math.min(ARC_CHARACTER_LIMIT, candidates)
}
/** 综合余量:失败重试 + 切段重叠(默认重叠 1000 字/单元 ≈ 10% 输入)等(预检宁高勿低) */
const SAFETY_FACTOR = 1.1

/**
 * 预估一次世界生成的 token 消耗:按真实流水线分阶段建模
 * (提取全量正文 → 一致性检查压缩实体 → 成书头部卡片 + 作者识别),随生成参数收敛。
 * 正文按 CJK_TOKEN_PER_CHAR(0.7 token/汉字,实测主流 tokenizer 校准)折算;
 * 典型结果 ≈ 全书字数的 1.0~1.4 倍(节约模式更低),与真实入账同量级。
 * steps 为自定义模式的步骤开关(仅 mode=custom 时使用):关掉的步骤不计入,
 * synth 关闭=轻量成书(同节约模式成书项),arcs 开启时按候选角色上限计入。
 */
export function estimateWorldGenTokens(
  totalChars: number,
  eco = false,
  limits: GenLimits = DEFAULT_GEN_LIMITS,
  steps?: WorldGenStepSwitches | null
): number {
  if (!Number.isFinite(totalChars) || totalChars <= 0) return 1
  const unitMax = Math.max(1000, limits.unitMaxChars || DEFAULT_GEN_LIMITS.unitMaxChars)
  const units = Math.max(1, Math.ceil(totalChars / unitMax))
  // 提取:输入 = 全书正文 + 每单元提示词开销;输出 = 每单元典型提取 JSON(自定义模式提取必做)
  const textTokens = Math.ceil(totalChars * CJK_TOKEN_PER_CHAR)
  const extract = textTokens
    + units * EXTRACT_INPUT_OVERHEAD_TOKENS
    + units * (eco ? ECO_EXTRACT_OUTPUT_TOKENS : EXTRACT_OUTPUT_TOKENS)
  // 一致性检查(节约模式或自定义关闭时跳过):输入 = 压缩实体库 + 指令,输出 = 批注/新冲突
  const checkOn = !eco && (steps ? steps.check : true)
  const check = checkOn
    ? Math.ceil(textTokens * CHECK_INPUT_TOKEN_RATIO) + CHECK_INPUT_OVERHEAD_TOKENS + CHECK_OUTPUT_TOKENS
    : 0
  // 成书:完整(或自定义开启)= AI 完整卡;节约/自定义关闭 = 轻量成书 + 本地直拼
  const synthFull = !eco && (steps ? steps.synth : true)
  const synth = Math.ceil(textTokens * (synthFull ? SYNTH_INPUT_TOKEN_RATIO : ECO_SYNTH_INPUT_TOKEN_RATIO))
    + SYNTH_INPUT_OVERHEAD_TOKENS
    + (synthFull ? SYNTH_OUTPUT_TOKENS : ECO_SYNTH_OUTPUT_TOKENS)
  // 作者识别(自定义关闭时跳过):正文抽样输入 + 未命中时联网检索,输出极少
  const author = steps && !steps.author ? 0 : AUTHOR_TOKENS
  // 配角故事线(仅自定义开启或完整模式计入;eco 与自定义关闭为 0):
  // 每候选角色一次调用(输入含主线 beats 节选 + 角色素材 + 登场段原文窗口,输出独立弧线)
  const arcsOn = !eco && (steps ? steps.arcs : true)
  const arcs = arcsOn
    ? arcsCandidateCount(totalChars) * (ARCS_UNIT_INPUT_TOKENS + ARCS_UNIT_OUTPUT_TOKENS)
    : 0
  return Math.max(1, Math.round((extract + check + synth + author + arcs) * SAFETY_FACTOR))
}

/** 拉取共享缓存的价格:记录消耗的一半(向下取整;0 消耗的缓存免费) */
export function cacheHalfCost(tokensUsed: number): number {
  return Math.max(0, Math.floor((tokensUsed || 0) / 2))
}
