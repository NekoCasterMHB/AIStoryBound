// app/utils/genSettings.ts
// 生成参数(类型/默认值/范围)定义在 shared/gen-limits.ts,此处 re-export 保持调用方不变。
// 该配置为纯本地偏好,持久化在 localStorage,不做云端同步:
// 未设置/损坏一律回落 DEFAULT_GEN_LIMITS,只有本机显式保存过的值才生效。
import { DEFAULT_GEN_LIMITS, GEN_LIMIT_KEYS, GEN_LIMIT_RANGE, normalizeGenLimits } from '#shared/gen-limits'
import type { GenLimits } from '#shared/gen-limits'

export { DEFAULT_GEN_LIMITS, GEN_LIMIT_KEYS, GEN_LIMIT_RANGE, normalizeGenLimits }
export type { GenLimits }

// 版本化 key:与云端同步时代遗留的 gen-limits-v1 分开,避免继承旧值,
// 让早期被写入范围下限的账号也能回到正确默认值
const LS_KEY = 'gen-limits-v2'

/** 旧默认值(输入分段/输出上限沿用旧默认会与新版行为不一致或截断输出);存过旧默认值的账号升级到新默认,其余自定义字段保留 */
const LEGACY_UNIT_MAX_CHARS = 20000
const LEGACY_UNIT_MAX_CHARS_V2 = 30000
const LEGACY_UNIT_MAX_CHARS_V3 = 50000
const LEGACY_EXTRACT_MAX_TOKENS = 10000
const LEGACY_CHECK_MAX_TOKENS = 20000
const LEGACY_SYNTH_MAX_TOKENS = 32768

/** 迁移旧版默认值:仍为旧默认的字段升级到新默认,其余自定义字段保留 */
function migrateLegacyDefaults(limits: GenLimits): GenLimits {
  if (limits.unitMaxChars === LEGACY_UNIT_MAX_CHARS
    || limits.unitMaxChars === LEGACY_UNIT_MAX_CHARS_V2
    || limits.unitMaxChars === LEGACY_UNIT_MAX_CHARS_V3) {
    limits.unitMaxChars = DEFAULT_GEN_LIMITS.unitMaxChars
  }
  if (limits.extractMaxTokens === LEGACY_EXTRACT_MAX_TOKENS) {
    limits.extractMaxTokens = DEFAULT_GEN_LIMITS.extractMaxTokens
  }
  if (limits.checkMaxTokens === LEGACY_CHECK_MAX_TOKENS) {
    limits.checkMaxTokens = DEFAULT_GEN_LIMITS.checkMaxTokens
  }
  if (limits.synthMaxTokens === LEGACY_SYNTH_MAX_TOKENS) {
    limits.synthMaxTokens = DEFAULT_GEN_LIMITS.synthMaxTokens
  }
  return limits
}

/**
 * 判定"全部设置成范围最小值"的异常配置:历史 bug 会把字段钳制到各自下限(输入 1000 字符、
 * 三个输出上限 512/512/2048、超时 30s),输出必然被截断,不可能是用户有意的合理配置。
 * unitOverlapChars 的 min 为 0(关闭重叠)是合法值,不参与判定。
 */
function isAllMinLimits(limits: GenLimits): boolean {
  return limits.unitMaxChars === GEN_LIMIT_RANGE.unitMaxChars.min
    && limits.extractMaxTokens === GEN_LIMIT_RANGE.extractMaxTokens.min
    && limits.checkMaxTokens === GEN_LIMIT_RANGE.checkMaxTokens.min
    && limits.synthMaxTokens === GEN_LIMIT_RANGE.synthMaxTokens.min
    && limits.relayTimeoutSec === GEN_LIMIT_RANGE.relayTimeoutSec.min
}

function readLocal(): GenLimits {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_GEN_LIMITS }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULT_GEN_LIMITS }
    let limits = normalizeGenLimits(JSON.parse(raw) as Partial<GenLimits>)
    limits = migrateLegacyDefaults(limits)
    // 全部最小值是历史 bug 残留:整体重置为当前默认并写回,个人中心立即显示修正后的值
    if (isAllMinLimits(limits)) {
      writeLocal({ ...DEFAULT_GEN_LIMITS })
      return { ...DEFAULT_GEN_LIMITS }
    }
    return limits
  } catch {
    // 数据损坏按默认处理
    return { ...DEFAULT_GEN_LIMITS }
  }
}

function writeLocal(limits: GenLimits): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(limits))
  } catch {
    // 隐私模式等存储不可用时静默忽略,不影响本次会话
  }
}

/** 读取本地生成参数(未设置/损坏回落默认值) */
export function loadGenLimits(): GenLimits {
  return readLocal()
}

/** 生成前取当前生成参数(本地读取;保留 async 签名兼容旧调用方) */
export async function fetchGenLimits(): Promise<GenLimits> {
  return readLocal()
}

/** 保存生成参数到本地(个人中心) */
export async function saveGenLimits(limits: GenLimits): Promise<boolean> {
  writeLocal(normalizeGenLimits(limits))
  return true
}

/** 恢复默认并写回本地 */
export async function resetGenLimits(): Promise<boolean> {
  writeLocal({ ...DEFAULT_GEN_LIMITS })
  return true
}
