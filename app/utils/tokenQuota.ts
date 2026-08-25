// app/utils/tokenQuota.ts
// 生成世界前的平台 token 额度预检:自建 API Key 模式不消耗平台余额,无需检测
import { getActiveRelayConfig } from './aiConfigStore'

export interface TokenQuotaInfo {
  /** 当前平台 token 余额 */
  balance: number
  /** 预计本次生成所需 token(小说字数 × multiplier) */
  needed: number
  /** 估算系数:完整模式 ×1.5,节约模式 ×1.2(不做一致性检查与人物卡润色) */
  multiplier: number
  /** 余额是否不足以支撑生成 */
  insufficient: boolean
}

/** 预估一次世界生成的 token 消耗:小说字数 × 系数(含 prompt 与输出余量,与额度预检同一口径) */
export function estimateWorldGenTokens(totalChars: number, eco = false): number {
  return Math.max(1, Math.round(totalChars * (eco ? 1.2 : 1.5)))
}

/**
 * 检查平台剩余 token 是否足够支撑本次世界生成。
 * 判定:余额 < 小说字数 × 系数(预留余量,避免生成中途余额耗尽而失败)。
 * 返回 null 表示无需检测(已启用自建 API 配置、未登录或余额查询失败——后者交给服务端逐次拦截)。
 */
export async function checkWorldGenQuota(totalChars: number, opts: { eco?: boolean } = {}): Promise<TokenQuotaInfo | null> {
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
  const multiplier = opts.eco ? 1.2 : 1.5
  const needed = Math.max(1, Math.round(totalChars * multiplier))
  return { balance, needed, multiplier, insufficient: balance < needed }
}
