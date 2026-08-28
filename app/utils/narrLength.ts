// app/utils/narrLength.ts
// 每回合生成字数(本地偏好,默认 200 字):回合正文(打字机区域)AI 输出的目标篇幅。
// 范围 200~1000 字、步进 50;设置入口:个人中心滑动条(即时保存);游戏页每回合读入,
// 注入叙事提示词字数约束并据此缩放叙事调用 maxTokens(选项/状态结算不受影响)。
const KEY = 'narr-length'

export const NARR_LENGTH_MIN = 200
export const NARR_LENGTH_MAX = 1000
export const NARR_LENGTH_STEP = 50
export const NARR_LENGTH_DEFAULT = 200

export function loadNarrLength(): number {
  if (typeof localStorage === 'undefined') return NARR_LENGTH_DEFAULT
  try {
    const v = parseFloat(localStorage.getItem(KEY) ?? '')
    if (!Number.isNaN(v) && v >= NARR_LENGTH_MIN && v <= NARR_LENGTH_MAX) {
      // 对齐到步进整数倍
      const snapped = Math.round((v - NARR_LENGTH_MIN) / NARR_LENGTH_STEP) * NARR_LENGTH_STEP + NARR_LENGTH_MIN
      return Math.min(NARR_LENGTH_MAX, Math.max(NARR_LENGTH_MIN, snapped))
    }
  } catch {
    // 数据损坏按默认处理
  }
  return NARR_LENGTH_DEFAULT
}

export function saveNarrLength(v: number): void {
  if (typeof localStorage === 'undefined') return
  const snapped = Math.round((v - NARR_LENGTH_MIN) / NARR_LENGTH_STEP) * NARR_LENGTH_STEP + NARR_LENGTH_MIN
  localStorage.setItem(KEY, String(Math.min(NARR_LENGTH_MAX, Math.max(NARR_LENGTH_MIN, snapped))))
}
