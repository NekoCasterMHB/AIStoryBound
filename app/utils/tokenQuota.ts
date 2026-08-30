// app/utils/tokenQuota.ts
// 生成世界前的平台 token 额度预检:自建 API Key 模式不消耗平台余额,无需检测
import { getActiveRelayConfig } from './aiConfigStore'
import { DEFAULT_GEN_LIMITS, loadGenLimits } from './genSettings'
import type { GenLimits } from './genSettings'
import { CJK_TOKEN_PER_CHAR } from '#shared/token-estimate'

export interface TokenQuotaInfo {
  /** 当前平台 token 余额 */
  balance: number
  /** 预计本次生成所需 token(按生成流水线逐阶段估算,含余量) */
  needed: number
  /** 余额是否不足以支撑生成 */
  insufficient: boolean
}

// ---- 流水线估算参数(与 shared/world-build 的真实请求结构对应;按实测消耗校准,宁高勿低) ----
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
/** 综合余量:失败重试 + 切段重叠(默认重叠 1000 字/单元 ≈ 10% 输入)等(预检宁高勿低) */
const SAFETY_FACTOR = 1.1

/**
 * 预估一次世界生成的 token 消耗:按真实流水线分阶段建模
 * (提取全量正文 → 一致性检查压缩实体 → 成书头部卡片 + 作者识别),随生成参数收敛。
 * 正文按 CJK_TOKEN_PER_CHAR(0.7 token/汉字,实测主流 tokenizer 校准)折算;
 * 典型结果 ≈ 全书字数的 1.0~1.4 倍(节约模式更低),与真实入账同量级。
 */
export function estimateWorldGenTokens(totalChars: number, eco = false, limits: GenLimits = loadGenLimits()): number {
  if (!Number.isFinite(totalChars) || totalChars <= 0) return 1
  const unitMax = Math.max(1000, limits.unitMaxChars || DEFAULT_GEN_LIMITS.unitMaxChars)
  const units = Math.max(1, Math.ceil(totalChars / unitMax))
  // 提取:输入 = 全书正文 + 每单元提示词开销;输出 = 每单元典型提取 JSON
  const textTokens = Math.ceil(totalChars * CJK_TOKEN_PER_CHAR)
  const extract = textTokens
    + units * EXTRACT_INPUT_OVERHEAD_TOKENS
    + units * (eco ? ECO_EXTRACT_OUTPUT_TOKENS : EXTRACT_OUTPUT_TOKENS)
  // 一致性检查(节约模式跳过):输入 = 压缩实体库 + 指令,输出 = 批注/新冲突
  const check = eco
    ? 0
    : Math.ceil(textTokens * CHECK_INPUT_TOKEN_RATIO) + CHECK_INPUT_OVERHEAD_TOKENS + CHECK_OUTPUT_TOKENS
  // 成书:输入 = 头部卡片素材 + 指令,输出 = 卡片/概览
  const synth = Math.ceil(textTokens * (eco ? ECO_SYNTH_INPUT_TOKEN_RATIO : SYNTH_INPUT_TOKEN_RATIO))
    + SYNTH_INPUT_OVERHEAD_TOKENS
    + (eco ? ECO_SYNTH_OUTPUT_TOKENS : SYNTH_OUTPUT_TOKENS)
  return Math.max(1, Math.round((extract + check + synth + AUTHOR_TOKENS) * SAFETY_FACTOR))
}

/**
 * 检查平台剩余 token 是否足够支撑本次世界生成。
 * 判定:余额 < 预估消耗(含余量,避免生成中途余额耗尽而失败)。
 * 返回 null 表示无需检测(已启用自建 API 配置、未登录或余额查询失败——后者交给服务端逐次拦截)。
 */
export async function checkWorldGenQuota(totalChars: number, opts: { eco?: boolean, limits?: GenLimits } = {}): Promise<TokenQuotaInfo | null> {
  try {
    if (await getActiveRelayConfig()) return null
  } catch {
    // 本地配置读取失败(如环境不支持 IndexedDB):按平台模式继续预检
  }
  let balance: number
  try {
    const me = await $fetch<{ aiTokenBalance?: number }>('/api/profile/me')
    balance = me?.aiTokenBalance ?? 0
  } catch {
    return null
  }
  const needed = estimateWorldGenTokens(totalChars, opts.eco ?? false, opts.limits)
  return { balance, needed, insufficient: balance < needed }
}
