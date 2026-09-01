// app/utils/reinjectPrefs.ts
// 段回注间隔(本地偏好,默认 8 回合):每 N 回合把当前细纲段情节 + 段首原文窗口重新注入叙事,
// 防止长局偏离故事线。设置入口:个人中心 / 游戏内设置弹窗;新回合生效。
const KEY = 'reinject-interval'

export const REINJECT_INTERVAL_MIN = 1
export const REINJECT_INTERVAL_MAX = 20
export const REINJECT_INTERVAL_DEFAULT = 8

export function loadReinjectInterval(): number {
  if (typeof localStorage === 'undefined') return REINJECT_INTERVAL_DEFAULT
  try {
    const v = parseInt(localStorage.getItem(KEY) ?? '', 10)
    if (!Number.isNaN(v) && v >= REINJECT_INTERVAL_MIN && v <= REINJECT_INTERVAL_MAX) return v
  } catch {
    // 数据损坏按默认处理
  }
  return REINJECT_INTERVAL_DEFAULT
}

export function saveReinjectInterval(v: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, String(Math.round(v)))
}
