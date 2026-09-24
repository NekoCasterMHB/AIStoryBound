// app/utils/narrPrefs.ts
// 叙事温度(本地偏好,默认 1.0):回合正文生成的随机性/文风多样性档位。
// 范围 0~1.0、步进 0.1;档位划分依据社区常用区间(稳定叙事优先,高温易跳设定/情节失控)。
// 设置入口:个人中心/游戏内设置滑动条(即时保存);游戏页每回合读入注入叙事调用。
// 存量迁移:旧版本上限 2.0,超出新上限的存档值在读取时按越界处理自动回落默认 1.0。
const KEY = 'narr-temperature'

export const NARR_TEMP_MIN = 0
export const NARR_TEMP_MAX = 1.0
export const NARR_TEMP_STEP = 0.1
export const NARR_TEMP_DEFAULT = 1.0

export interface TempTier {
  /** 档位名 */
  label: string
  /** 档位区间(含端点) */
  range: [number, number]
  /** 档位说明(设置页展示) */
  desc: string
}

export const NARR_TEMP_TIERS: TempTier[] = [
  { label: '稳定', range: [0, 0.6], desc: '严格遵循人物卡与设定,文风收敛,叙事保守' },
  { label: '均衡', range: [0.7, 1.0], desc: '兼顾文笔与稳定性,叙事平稳(默认档 1.0,上限)' }
]

export function loadNarrTemp(): number {
  if (typeof localStorage === 'undefined') return NARR_TEMP_DEFAULT
  try {
    const v = parseFloat(localStorage.getItem(KEY) ?? '')
    if (!Number.isNaN(v) && v >= NARR_TEMP_MIN && v <= NARR_TEMP_MAX) return Math.round(v * 10) / 10
  } catch {
    // 数据损坏按默认处理
  }
  return NARR_TEMP_DEFAULT
}

export function saveNarrTemp(v: number): void {
  if (typeof localStorage === 'undefined') return
  const clamped = Math.min(NARR_TEMP_MAX, Math.max(NARR_TEMP_MIN, Math.round(v * 10) / 10))
  localStorage.setItem(KEY, String(clamped))
}

/** 当前温度所属档位(区间外返回 null) */
export function narrTempTier(v: number): TempTier | null {
  return NARR_TEMP_TIERS.find(t => v >= t.range[0] && v <= t.range[1]) ?? null
}
