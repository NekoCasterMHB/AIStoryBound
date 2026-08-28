// shared/gen-limits.ts
// 生成参数的类型、默认值与合法范围(客户端与服务端共用)。
// 该配置为纯本地偏好(localStorage,见 app/utils/genSettings.ts),不随账户同步;
// normalizeGenLimits 对任意来源的值钳制到合法范围,缺省/非法回落默认值。
import { UNIT_MAX_CHARS, UNIT_OVERLAP_CHARS, CHECK_MAX_TOKENS, SYNTH_MAX_TOKENS } from './world-build'
import { RELAY_TIMEOUT_DEFAULT_MS, RELAY_TIMEOUT_MIN_MS, RELAY_TIMEOUT_MAX_MS } from './ai-config'

export interface GenLimits {
  /** 单提取单元正文上限(字符):控制每次提取调用的输入体积 */
  unitMaxChars: number
  /** 超限长章切段时相邻段的重叠区(字符):0=关闭 */
  unitOverlapChars: number
  /** 提取单次输出上限(tokens):控制每次提取调用的输出封顶 */
  extractMaxTokens: number
  /** 一致性检查单次输出上限(tokens):控制 AI 复核冲突调用的输出封顶 */
  checkMaxTokens: number
  /** 成书单次输出上限(tokens):控制简介+人物卡调用的输出封顶 */
  synthMaxTokens: number
  /** 单次 AI 调用等待超时(秒):调大输出上限后建议同步调大 */
  relayTimeoutSec: number
}

/** 默认与代码常量一致(20000/1000/10000/20000/32768/600s) */
export const DEFAULT_GEN_LIMITS: GenLimits = {
  unitMaxChars: UNIT_MAX_CHARS,
  unitOverlapChars: UNIT_OVERLAP_CHARS,
  extractMaxTokens: 10000,
  checkMaxTokens: CHECK_MAX_TOKENS,
  synthMaxTokens: SYNTH_MAX_TOKENS,
  relayTimeoutSec: RELAY_TIMEOUT_DEFAULT_MS / 1000
}

export const GEN_LIMIT_RANGE = {
  unitMaxChars: { min: 1000, max: 200000, step: 500 },
  unitOverlapChars: { min: 0, max: 5000, step: 100 },
  extractMaxTokens: { min: 512, max: 384000, step: 512 },
  // 检查/成书输入受压缩控制(实体库紧凑序列化),输出上限给足避免截断
  checkMaxTokens: { min: 512, max: 32768, step: 512 },
  synthMaxTokens: { min: 2048, max: 32768, step: 1024 },
  relayTimeoutSec: { min: RELAY_TIMEOUT_MIN_MS / 1000, max: RELAY_TIMEOUT_MAX_MS / 1000, step: 10 }
} as const

/** 全部字段键(顺序即展示/存储顺序) */
export const GEN_LIMIT_KEYS = Object.keys(DEFAULT_GEN_LIMITS) as (keyof GenLimits)[]

/**
 * 把任意来源(接口请求体/D1 行)的数值钳制到合法范围:
 * 字段缺失/null/非有限数回落默认值(注意 Number(null)===0,必须显式判空,
 * 否则 D1 可空列未设置时会被当 0 钳到范围最小值,新用户看到的是下限而非默认值);
 * 数值越界收拢到范围边界;重叠等 min=0 的字段 0 合法保留。
 */
export function normalizeGenLimits(v: Partial<Record<keyof GenLimits, unknown>> | null | undefined): GenLimits {
  const out = { ...DEFAULT_GEN_LIMITS }
  if (!v) return out
  for (const key of GEN_LIMIT_KEYS) {
    const raw = v[key]
    if (raw === null || raw === undefined || raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) continue
    const range = GEN_LIMIT_RANGE[key]
    out[key] = Math.min(range.max, Math.max(range.min, Math.round(n)))
  }
  return out
}
