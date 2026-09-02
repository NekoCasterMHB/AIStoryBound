// shared/demand.ts
// 需求墙:常量、类型与输入校验工具(浏览器 / 服务器共用)。
// 规则:游客可浏览;发起需求与点赞需登录;按点赞数排序,高赞需求优先实现。
import { uuid } from './novel'

/** 需求标题字数上限 */
export const MAX_DEMAND_TITLE_CHARS = 60
/** 需求描述字数上限 */
export const MAX_DEMAND_DESC_CHARS = 500

export type DemandStatus = 'open' | 'in_progress' | 'done'

export const DEMAND_STATUS_LABELS: Record<DemandStatus, string> = {
  open: '待实现',
  in_progress: '开发中',
  done: '已实现'
}

/** 需求墙列表项(公开字段;liked=当前用户是否已赞,仅登录用户有值) */
export interface DemandItem {
  id: string
  title: string
  desc: string
  likeCount: number
  status: DemandStatus
  /** 当前登录用户是否已点赞(未登录为 false) */
  liked: boolean
  authorName: string
  /** 发起人邮箱:仅管理端列表返回(公开接口出于隐私不含),公开端恒为 undefined */
  authorEmail?: string | null
  createdAt: number
}

/** 校验需求标题/描述(trim 后校验长度),返回处理后的值;非法抛 Error 面向用户提示 */
export function normalizeDemandInput(rawTitle: string, rawDesc: string): { title: string, desc: string } {
  const title = rawTitle.trim()
  const desc = rawDesc.trim()
  if (!title) {
    throw new Error('请填写需求标题')
  }
  if (title.length > MAX_DEMAND_TITLE_CHARS) {
    throw new Error(`标题不能超过 ${MAX_DEMAND_TITLE_CHARS} 字`)
  }
  if (!desc) {
    throw new Error('请填写需求描述')
  }
  if (desc.length > MAX_DEMAND_DESC_CHARS) {
    throw new Error(`描述不能超过 ${MAX_DEMAND_DESC_CHARS} 字`)
  }
  return { title, desc }
}

/** 生成需求/点赞记录 id */
export function newDemandId(): string {
  return uuid()
}
