// app/utils/genSettings.ts
// 生成参数(类型/默认值/范围)定义在 shared/gen-limits.ts,此处 re-export 保持调用方不变;
// 配置持久化已迁移到云端 D1(随用户账户,/api/profile/gen-limits),不再以 localStorage 为准。
// 本文件剩余职责:
//   - fetchGenLimits: 生成前拉取云端配置(带进程内缓存)
//   - loadGenLimits:  遗留 localStorage 读取,仅个人中心做一次性迁移时用
import { DEFAULT_GEN_LIMITS, GEN_LIMIT_KEYS, GEN_LIMIT_RANGE, normalizeGenLimits } from '#shared/gen-limits'
import type { GenLimits } from '#shared/gen-limits'

export { DEFAULT_GEN_LIMITS, GEN_LIMIT_KEYS, GEN_LIMIT_RANGE, normalizeGenLimits }
export type { GenLimits }

// ---- 云端配置(用户账户) ----

let remoteCache: GenLimits | null = null

/** 拉取用户账户的生成参数;失败(网络/未登录)回落默认值 */
export async function fetchGenLimits(force = false): Promise<GenLimits> {
  if (remoteCache && !force) return remoteCache
  try {
    const res = await $fetch<GenLimits & { stored?: boolean }>('/api/profile/gen-limits')
    const { stored: _stored, ...limits } = res
    remoteCache = normalizeGenLimits(limits)
    return remoteCache
  } catch {
    return { ...DEFAULT_GEN_LIMITS }
  }
}

/** 保存生成参数到云端(个人中心,需登录);成功刷新缓存 */
export async function saveGenLimits(limits: GenLimits): Promise<boolean> {
  try {
    const res = await $fetch<GenLimits & { ok?: boolean }>('/api/profile/gen-limits', {
      method: 'PUT',
      body: { ...limits }
    }).catch(() => null)
    if (!res) return false
    remoteCache = normalizeGenLimits(res)
    return true
  } catch {
    return false
  }
}

/** 恢复默认并同步云端(空 body 落默认值) */
export async function resetGenLimits(): Promise<boolean> {
  return saveGenLimits({ ...DEFAULT_GEN_LIMITS })
}

/** 云端配置变更后清缓存(个人中心保存/恢复默认后调用) */
export function clearGenLimitsCache(): void {
  remoteCache = null
}

// ---- 遗留 localStorage(旧版个人中心配置;仅一次性迁移,不再作为运行期来源) ----

const LS_KEY = 'gen-limits-v1'

/** 读取旧 localStorage 配置(缺失/损坏/环境不支持时返回默认值);迁移完成即可弃用 */
export function loadGenLimits(): GenLimits {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_GEN_LIMITS }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<GenLimits>
      return normalizeGenLimits(v)
    }
  } catch {
    // 数据损坏按默认处理
  }
  return { ...DEFAULT_GEN_LIMITS }
}
