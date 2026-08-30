// app/utils/tokenQuota.ts
// 生成世界前的平台 token 额度预检:自建 API Key 模式不消耗平台余额,无需检测
// (流水线估算已下沉 shared/world-gen-task.ts,服务端预授权与客户端预检共用同一口径)
import { getActiveRelayConfig } from './aiConfigStore'
import { loadGenLimits } from './genSettings'
import type { GenLimits } from './genSettings'
import { estimateWorldGenTokens } from '#shared/world-gen-task'

export interface TokenQuotaInfo {
  /** 当前平台 token 余额 */
  balance: number
  /** 预计本次生成所需 token(按生成流水线逐阶段估算,含余量) */
  needed: number
  /** 余额是否不足以支撑生成 */
  insufficient: boolean
}

export { estimateWorldGenTokens }

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
  const needed = estimateWorldGenTokens(totalChars, opts.eco ?? false, opts.limits ?? loadGenLimits())
  return { balance, needed, insufficient: balance < needed }
}
