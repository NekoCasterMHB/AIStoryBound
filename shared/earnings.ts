// shared/earnings.ts
// 收益账本(shared 层:类型 + 文案;前后端共用)。
// 收益来源统一先进 earnings 表挂账(pending),用户在个人中心点「获取」才入 user.ai_token_balance;
// 管理员发放同样进账本(带自定义原因 reason)。销售分成来源可经 source_id 反查购买记录。

/** 收益状态:pending=待领取(未入账)| claimed=已领取(已入 ai_token_balance) */
export type EarningsStatus = 'pending' | 'claimed'

export const EARNINGS_STATUS_LABELS: Record<EarningsStatus, string> = {
  pending: '待领取',
  claimed: '已领取'
}

/** 收益来源类型 */
export type EarningsSourceType = 'novel_sale' | 'skill_sale' | 'admin'

export const EARNINGS_SOURCE_LABELS: Record<EarningsSourceType, string> = {
  novel_sale: '小说销售分成',
  skill_sale: '技能销售分成',
  admin: '管理员发放'
}

/** 收益账本单行(服务端返回结构,时间统一为毫秒时间戳) */
export interface EarningsRow {
  id: string
  amount: number
  sourceType: EarningsSourceType
  /** 关联购买记录 id(admin 发放为空) */
  sourceId: string | null
  /** 来源名称快照(如「《xx》销售分成」/「管理员发放」) */
  itemTitle: string
  /** 自定义原因(管理员发放填写) */
  reason: string | null
  status: EarningsStatus
  createdAt: number
  claimedAt: number | null
}

/** 管理员发放入参/校验上限 */
export const EARNINGS_REASON_MAX = 200
export const EARNINGS_AMOUNT_MAX = 1_000_000_000
