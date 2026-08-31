// app/utils/narrSpeed.ts
// 叙事速度(本地偏好,IndexedDB 持久化):回合正文流式显示的速率档位。
// 档位:慢 20 / 标准 30 / 快 40 字符/秒,默认「标准」;另支持自定义任意字符/秒(钳制在合理范围)。
// 设置入口:个人中心 → 游玩偏好(叙事速度卡片,即时保存)与游戏内设置弹窗;
// 游戏页每回合读入,连同 pauseScale(标点停顿缩放)一起用于打字机。
import { db, STORE_PREFS } from './localDb'

export const NARR_SPEED_KEY = 'narr-speed'

/** 存储版本:升级档位表/迁移规则时递增,旧版本值在 load 时走迁移映射 */
const NARR_SPEED_STORE_V = 2

export interface SpeedTier {
  /** 档位名 */
  label: string
  /** 字符/秒(人类阅读速度:1200/1800/2400 字每分钟) */
  cps: number
  /** 标点停顿缩放(慢放慢停顿,快缩短停顿) */
  pauseScale: number
  /** 档位说明(设置页展示) */
  desc: string
}

export const NARR_SPEED_TIERS: SpeedTier[] = [
  { label: '慢', cps: 20, pauseScale: 1.5, desc: '约 1200 字/分钟,逐字慢慢浮现,停顿拉长,适合细读' },
  { label: '标准', cps: 30, pauseScale: 1.0, desc: '约 1800 字/分钟,接近舒适阅读节奏(默认)' },
  { label: '快', cps: 40, pauseScale: 0.6, desc: '约 2400 字/分钟,快速上屏,停顿缩短,适合跳过' }
]

export const NARR_SPEED_DEFAULT = NARR_SPEED_TIERS[1]!

/** 自定义速度的合理范围(字符/秒):过低近乎逐字卡顿,过高无意义 */
export const NARR_SPEED_CUSTOM_MIN = 1
export const NARR_SPEED_CUSTOM_MAX = 200

/** 旧档位迁移:30/60/120(最早期)→ 10/20/40(中间档)→ 20/30/40(当前档);40 保持不变 */
const LEGACY_CPS_MAP: Record<number, number> = { 30: 20, 60: 30, 120: 40, 10: 20, 20: 30 }

/** 自定义/入参速度钳制到合理范围(0/负数/NaN 回落默认档) */
export function clampNarrCps(cps: number): number {
  const n = Math.round(Number.isFinite(cps) ? cps : NARR_SPEED_DEFAULT.cps)
  if (n <= 0) return NARR_SPEED_DEFAULT.cps
  return Math.min(NARR_SPEED_CUSTOM_MAX, Math.max(NARR_SPEED_CUSTOM_MIN, n))
}

/** 按 cps 取对应档位:命中档位返回档位;自定义值按其在慢↔快区间的比例插值 pauseScale */
export function narrSpeedTierOf(cps: number): SpeedTier {
  const tier = NARR_SPEED_TIERS.find(t => t.cps === cps)
  if (tier) return tier
  const lo = NARR_SPEED_TIERS[0]!
  const hi = NARR_SPEED_TIERS[NARR_SPEED_TIERS.length - 1]!
  const ratio = Math.min(1, Math.max(0, (cps - lo.cps) / (hi.cps - lo.cps)))
  const pauseScale = +(lo.pauseScale + (hi.pauseScale - lo.pauseScale) * ratio).toFixed(2)
  return { label: '自定义', cps, pauseScale, desc: `自定义 ${cps} 字符/秒` }
}

export async function loadNarrSpeed(): Promise<number> {
  if (typeof indexedDB === 'undefined') return NARR_SPEED_DEFAULT.cps
  try {
    const row = await db.table(STORE_PREFS).get(NARR_SPEED_KEY) as { cps?: number, v?: number } | undefined
    let cps = row?.cps
    if (typeof cps === 'number' && Number.isFinite(cps) && cps > 0) {
      // 旧版本(v<2,含 30/60/120 与 10/20/40 历史档位)先迁移;新版本原样保留(含自定义值)
      if ((row?.v ?? 0) < NARR_SPEED_STORE_V) cps = LEGACY_CPS_MAP[cps] ?? cps
      if (NARR_SPEED_TIERS.some(t => t.cps === cps)) return cps
      return clampNarrCps(cps)
    }
  } catch {
    // 存储不可用按默认
  }
  return NARR_SPEED_DEFAULT.cps
}

export async function saveNarrSpeed(cps: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await db.table(STORE_PREFS).put({ key: NARR_SPEED_KEY, cps: clampNarrCps(cps), v: NARR_SPEED_STORE_V })
  } catch {
    // 存储不可用忽略
  }
}
