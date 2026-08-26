// app/utils/narrPrefs.ts
// 叙事温度(本地偏好,默认 1.2):回合正文生成的随机性/文风多样性档位。
// 范围 0~2.0、步进 0.1(与 DeepSeek 官方 temperature 参数范围一致);
// 档位划分依据官方参数建议(创意写作/诗歌推荐 temperature=1.5)与社区常用区间。
// 设置入口:个人中心滑动条(即时保存);游戏页每回合读入注入叙事调用。
const KEY = 'narr-temperature'

export const NARR_TEMP_MIN = 0
export const NARR_TEMP_MAX = 2.0
export const NARR_TEMP_STEP = 0.1
export const NARR_TEMP_DEFAULT = 1.2

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
  { label: '均衡', range: [0.7, 1.0], desc: '兼顾文笔与稳定性,叙事平稳' },
  { label: '生动', range: [1.1, 1.5], desc: '文笔更丰富、角色更鲜活,偶有情节跳脱(默认档 1.2)' },
  { label: '创意', range: [1.6, 2.0], desc: '官方创意写作推荐区间,文风最自由,可能偏离原设定' }
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
  localStorage.setItem(KEY, String(Math.round(v * 10) / 10))
}

/** 当前温度所属档位(区间外返回 null) */
export function narrTempTier(v: number): TempTier | null {
  return NARR_TEMP_TIERS.find(t => v >= t.range[0] && v <= t.range[1]) ?? null
}
