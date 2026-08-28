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

function readLocal(): GenLimits {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_GEN_LIMITS }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULT_GEN_LIMITS }
    return normalizeGenLimits(JSON.parse(raw) as Partial<GenLimits>)
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
