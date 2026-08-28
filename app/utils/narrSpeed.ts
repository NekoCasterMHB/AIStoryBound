// app/utils/narrSpeed.ts
// 叙事速度(本地偏好,IndexedDB 持久化):回合正文流式显示的速率档位。
// 档位:慢 30 / 标准 60 / 快 120 字符/秒,默认「标准」。
// 设置入口:个人中心 → 游玩偏好(叙事速度卡片,即时保存);
// 游戏页每回合读入,连同 pauseScale(标点停顿缩放)一起用于打字机。
import { db, STORE_PREFS } from './localDb'

export const NARR_SPEED_KEY = 'narr-speed'

export interface SpeedTier {
  /** 档位名 */
  label: string
  /** 字符/秒(人类阅读速度:600/1200/2400 字每分钟) */
  cps: number
  /** 标点停顿缩放(慢放慢停顿,快缩短停顿) */
  pauseScale: number
  /** 档位说明(设置页展示) */
  desc: string
}

export const NARR_SPEED_TIERS: SpeedTier[] = [
  { label: '慢', cps: 10, pauseScale: 1.5, desc: '约 600 字/分钟,逐字慢慢浮现,停顿拉长,适合细读' },
  { label: '标准', cps: 20, pauseScale: 1.0, desc: '约 1200 字/分钟,接近舒适阅读节奏(默认)' },
  { label: '快', cps: 40, pauseScale: 0.6, desc: '约 2400 字/分钟,快速上屏,停顿缩短,适合跳过' }
]

export const NARR_SPEED_DEFAULT = NARR_SPEED_TIERS[1]!

/** 旧档位(30/60/120 字/秒)→ 新档位(10/20/40)一次性迁移映射 */
const LEGACY_CPS_MAP: Record<number, number> = { 30: 10, 60: 20, 120: 40 }

/** 按 cps 取对应档位(未命中返回标准档) */
export function narrSpeedTierOf(cps: number): SpeedTier {
  return NARR_SPEED_TIERS.find(t => t.cps === cps) ?? NARR_SPEED_DEFAULT
}

export async function loadNarrSpeed(): Promise<number> {
  if (typeof indexedDB === 'undefined') return NARR_SPEED_DEFAULT.cps
  try {
    const d = await db()
    const row = await d.get(STORE_PREFS, NARR_SPEED_KEY) as { cps?: number } | undefined
    let cps = row?.cps
    if (typeof cps === 'number' && Number.isFinite(cps) && cps > 0) {
      // 旧档位迁移到新档位;仍不在当前档位表则回落默认
      cps = LEGACY_CPS_MAP[cps] ?? cps
      if (NARR_SPEED_TIERS.some(t => t.cps === cps)) return cps
    }
  } catch {
    // 存储不可用按默认
  }
  return NARR_SPEED_DEFAULT.cps
}

export async function saveNarrSpeed(cps: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    const d = await db()
    await d.put(STORE_PREFS, { key: NARR_SPEED_KEY, cps })
  } catch {
    // 存储不可用忽略
  }
}
