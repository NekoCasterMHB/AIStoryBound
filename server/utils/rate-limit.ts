// server/utils/rate-limit.ts
// 进程内滑动窗口限流(无外部依赖):Worker 多 isolate 下计数不跨实例,不追求精确,
// 仅用于抬高滥用成本(redeem 防爆破、AI 配置测试防探测跳板等),不能作为硬性配额。
import { createError } from 'h3'

export interface RateLimiterOptions {
  /** 窗口时长(毫秒) */
  windowMs: number
  /** 窗口内允许的最大次数 */
  limit: number
  /** 超限时的 429 文案 */
  message?: string
}

export interface RateLimiter {
  /** 检查并计数 +1:超限抛 429,否则窗口内计数 +1(常规限流入口) */
  hit(key: string): void
  /** 仅检查是否已超限,不计数(失败计数型:入口检查用) */
  check(key: string): void
  /** 计数 +1,不检查(失败计数型:失败时记录用) */
  record(key: string): void
  /** 清零(失败计数型:成功后重置) */
  clear(key: string): void
}

interface Bucket { count: number, resetAt: number }

/** 单进程内所有 limiter 共用一个 Map 的清理阈值,防止长期膨胀 */
const MAX_BUCKETS = 1000

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, Bucket>()

  function sweep() {
    if (buckets.size <= MAX_BUCKETS) return
    const now = Date.now()
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k)
    }
  }

  function overLimit(key: string): boolean {
    const rec = buckets.get(key)
    return !!rec && rec.resetAt > Date.now() && rec.count >= opts.limit
  }

  function bump(key: string) {
    const now = Date.now()
    const rec = buckets.get(key)
    if (!rec || rec.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
    } else {
      rec.count++
    }
    sweep()
  }

  function throwIfOver(key: string) {
    if (overLimit(key)) {
      throw createError({ statusCode: 429, statusMessage: opts.message ?? '请求过于频繁,请稍后再试' })
    }
  }

  return {
    hit(key) {
      throwIfOver(key)
      bump(key)
    },
    check(key) {
      throwIfOver(key)
    },
    record(key) {
      bump(key)
    },
    clear(key) {
      buckets.delete(key)
    }
  }
}
