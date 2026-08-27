// shared/store-novel.ts
// 小说商城(创意工坊「书架」):常量、类型与 TXT 校验工具(浏览器 / 服务器共用)。
// 交易规则与 Skill 商城一致:买家按售价扣 token,卖家实得 售价*80%,20% 平台手续费。
// 正文 TXT 存 R2(每个版本独立文件,见 wrangler.toml SKILL_FILES 绑定),D1 仅存元数据与版本快照。

/** 单本小说 TXT 大小上限(字节,10MB) */
export const MAX_NOVEL_TXT_BYTES = 10 * 1024 * 1024
/** 书名上限 */
export const MAX_NOVEL_TITLE_CHARS = 60
/** 作者名上限 */
export const MAX_NOVEL_AUTHOR_CHARS = 30
/** 一句话简介上限 */
export const MAX_NOVEL_DESC_CHARS = 200
/** 可预览字数上限(发布者设置买家可免费阅读的正文前 N 字,0=不可预览) */
export const MAX_NOVEL_PREVIEW_CHARS = 100_000
/** 上架最少字数(太短不允许上架) */
export const MIN_NOVEL_CHARS = 500
/** 上传文件后缀白名单(小写) */
export const NOVEL_TXT_EXTENSIONS = ['.txt', '.text']
/** 管理端审核预览最多返回的字节数(正文过长时截断) */
export const MAX_NOVEL_REVIEW_BYTES = 50 * 1024

export type NovelStatus = 'pending' | 'approved' | 'rejected' | 'removed'

export const NOVEL_STATUS_LABELS: Record<NovelStatus, string> = {
  pending: '待审核',
  approved: '已上架',
  rejected: '已拒绝',
  removed: '已下架'
}

/** 商城列表项(公开字段;owned=是否已购买,仅登录用户有值) */
export interface StoreNovelSummary {
  id: string
  title: string
  /** 原著作者名(发布者填写,可空) */
  author: string | null
  /** 一句话简介(卡片展示) */
  desc: string
  price: number
  sellerName: string
  featured: number
  downloadCount: number
  purchaseCount: number
  createdAt: number
  owned: boolean
  /** 是否已购买(自己发布的商品不算;卡片售价区显示「已购买」tag) */
  purchased: boolean
  /** 可预览字数(买家未购买时可免费阅读正文前 N 字) */
  previewChars: number
  /** 全书字数(最新已上架版本快照) */
  totalChars: number
  /** 已上架版本(版本号倒序;「获取」可切换,旧版本通过后保持可下载) */
  versions: { version: number, createdAt: number }[]
  /** 发布者手动指定的主版本;为空 = 最新已上架版本(商城展示快照来源,「获取」默认目标) */
  mainVersion: number | null
}

/** 一个已提交版本(「我的发布」内嵌;发布者可下载任意版本) */
export interface NovelVersionBrief {
  version: number
  title: string
  author: string | null
  desc: string
  price: number
  previewChars: number
  totalChars: number
  status: NovelStatus
  rejectReason: string | null
  /** 1=启用 | 0=禁用(禁用版本用户侧隐藏) */
  enabled: number
  fileSize: number
  createdAt: number
}

/** 我发布的一条(商城「我的发布」) */
export interface MyPublishedNovel {
  id: string
  title: string
  author: string | null
  desc: string
  price: number
  previewChars: number
  totalChars: number
  status: NovelStatus
  rejectReason: string | null
  /** 手动指定的主版本;为空 = 最新已上架版本 */
  mainVersion: number | null
  featured: number
  downloadCount: number
  purchaseCount: number
  createdAt: number
  /** 最新版本号 */
  latestVersion: number
  /** 全部版本(版本号倒序) */
  versions: NovelVersionBrief[]
}

/** 我购买的一条(商城「我的购买」,可再次下载;购买者可选购买版本与后续已上架版本) */
export interface MyPurchasedNovel {
  id: string
  title: string
  desc: string
  price: number
  sellerName: string
  featured: number
  purchasedAt: number
  /** 购买时锁定的版本号(旧记录回退 1) */
  purchasedVersion: number
  /** 可下载的已上架版本列表(含购买版本与后续上架版本,带发布时间) */
  versions: { version: number, createdAt: number }[]
}

/** 计算分成(与 skill 相同):卖家所得 = round(price*80%),平台 = price - 卖家所得 */
export function splitNovelPrice(price: number): { sellerShare: number, platformFee: number } {
  const sellerShare = Math.round(price * 0.8)
  const platformFee = price - sellerShare
  return { sellerShare, platformFee }
}

/**
 * 解码小说 TXT:优先按 UTF-8 严格解码(BOM 剥离),失败回退 GBK(国内 TXT 常见编码)。
 * 两种编码都不支持时按 UTF-8 宽松解码(乱码但可预览)。字节数校验在解码前完成。
 */
export function decodeNovelText(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      text = new TextDecoder('gbk').decode(bytes)
    } catch {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    }
  }
  return text.replace(/^\uFEFF/, '')
}

/** 统计字数(按 Unicode 码点数,中文一字计 1) */
export function countNovelChars(text: string): number {
  return [...text].length
}

/** 取预览文本:正文前 chars 字(按 Unicode 码点,非法值按 0 处理) */
export function takeNovelPreview(text: string, chars: number): string {
  const n = Math.max(0, Math.floor(chars))
  return n <= 0 ? '' : [...text].slice(0, n).join('')
}

/** 字数格式化:1200 → 「1200 字」,15000 → 「1.5 万字」 */
export function fmtNovelChars(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1)}万字`
  return `${n.toLocaleString('zh-CN')}字`
}
