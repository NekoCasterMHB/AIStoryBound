// app/utils/genSettings.ts
// 世界生成的本地偏好(非敏感,localStorage 持久化,个人中心可改):
//   单单元输入上限(字符)与提取单次输出上限(tokens),默认与代码常量一致(8000/6000)。
// 输出上限可配置范围的上界参照 DeepSeek 官方文档:单次输出最大 384K(上下文 1M)。
import { UNIT_MAX_CHARS } from '#shared/world-build'

export interface GenLimits {
  /** 单提取单元正文上限(字符):控制每次提取调用的输入体积 */
  unitMaxChars: number
  /** 提取单次输出上限(tokens):控制每次提取调用的输出封顶 */
  extractMaxTokens: number
}

export const DEFAULT_GEN_LIMITS: GenLimits = {
  unitMaxChars: UNIT_MAX_CHARS,
  extractMaxTokens: 6000
}

export const GEN_LIMIT_RANGE = {
  unitMaxChars: { min: 1000, max: 200000, step: 500 },
  extractMaxTokens: { min: 512, max: 384000, step: 512 }
} as const

const LS_KEY = 'gen-limits-v1'

let cached: GenLimits | null = null

function clamp(v: unknown, fallback: number, range: { min: number, max: number }): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(range.max, Math.max(range.min, n))
}

/** 读取生成参数(localStorage;未配置/数据损坏/环境不支持时返回默认值) */
export function loadGenLimits(): GenLimits {
  if (cached) return cached
  if (typeof localStorage === 'undefined') return { ...DEFAULT_GEN_LIMITS }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<GenLimits>
      cached = {
        unitMaxChars: clamp(v.unitMaxChars, DEFAULT_GEN_LIMITS.unitMaxChars, GEN_LIMIT_RANGE.unitMaxChars),
        extractMaxTokens: clamp(v.extractMaxTokens, DEFAULT_GEN_LIMITS.extractMaxTokens, GEN_LIMIT_RANGE.extractMaxTokens)
      }
      return cached
    }
  } catch {
    // 数据损坏按默认处理
  }
  cached = { ...DEFAULT_GEN_LIMITS }
  return cached
}

/** 保存生成参数(存储不可用时仅本次会话内生效) */
export function saveGenLimits(limits: GenLimits): void {
  cached = { ...limits }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cached))
  } catch {
    // 隐私模式等场景存储不可用:静默
  }
}

/** 恢复默认并清除本地存储 */
export function resetGenLimits(): void {
  cached = { ...DEFAULT_GEN_LIMITS }
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    // 忽略
  }
}