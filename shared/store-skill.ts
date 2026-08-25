// shared/store-skill.ts
// Skill 商城:常量、类型与 zip 校验工具(浏览器 / 服务器共用)。
// 交易规则:买家按售价扣 token,卖家实得 售价*80%(直接进发布者余额),20% 平台手续费。
import { unzipSync } from 'fflate'

/** 卖家分成比例 */
export const SELLER_RATIO = 0.8
/** 平台手续费比例 */
export const PLATFORM_RATIO = 0.2

/** 单个 skill 压缩包大小上限(字节,10MB) */
export const MAX_SKILL_ZIP_BYTES = 10 * 1024 * 1024
/** 名称字数上限 */
export const MAX_SKILL_NAME_CHARS = 60
/** 说明文字数上限 */
export const MAX_SKILL_DESC_CHARS = 500
/** 上传文件后缀白名单(小写) */
export const SKILL_ZIP_EXTENSIONS = ['.zip']

export type SkillStatus = 'pending' | 'approved' | 'rejected' | 'removed'

export const SKILL_STATUS_LABELS: Record<SkillStatus, string> = {
  pending: '待审核',
  approved: '已上架',
  rejected: '已拒绝',
  removed: '已下架'
}

/** zip 内单个条目(上传校验产物,管理端预览用) */
export interface SkillFileEntry {
  name: string
  /** 目录或展开后字节数 */
  size: number
  isDirectory: boolean
}

/** 商城列表项(公开字段;owned=是否已购买,仅登录用户有值) */
export interface StoreSkillSummary {
  id: string
  name: string
  desc: string
  price: number
  sellerName: string
  featured: number
  downloadCount: number
  purchaseCount: number
  createdAt: number
  owned: boolean
}

/** 一个已提交版本(「我的发布」内嵌;发布者可下载任意版本) */
export interface SkillVersionBrief {
  version: number
  name: string
  desc: string
  price: number
  status: SkillStatus
  rejectReason: string | null
  fileSize: number
  createdAt: number
}

/** 我发布的一条(商城「我的发布」) */
export interface MyPublishedSkill {
  id: string
  name: string
  desc: string
  price: number
  status: SkillStatus
  rejectReason: string | null
  featured: number
  downloadCount: number
  purchaseCount: number
  createdAt: number
  /** 最新版本号 */
  latestVersion: number
  /** 全部版本(版本号倒序) */
  versions: SkillVersionBrief[]
}

/** 我购买的一条(商城「我的购买」,可再次下载;购买者可选购买版本与后续已上架版本) */
export interface MyPurchasedSkill {
  id: string
  name: string
  desc: string
  price: number
  sellerName: string
  featured: number
  purchasedAt: number
  /** 购买时锁定的版本号(旧记录回退 1) */
  purchasedVersion: number
  /** 可下载的已上架版本号列表(含购买版本与后续上架版本) */
  versions: number[]
}

/**
 * 解析 zip 内容,返回文件清单(不读取正文)。
 * 校验规则:必须是 fflate 可解压的 zip,且根目录含 SKILL.md(市面通用 agent skill 格式)。
 * 抛 Error 表示格式不合法,message 面向用户提示。
 */
export function parseSkillZip(data: Uint8Array): { entries: SkillFileEntry[], hasSkillMd: boolean } {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data)
  } catch (e) {
    throw new Error('文件不是合法的 zip 压缩包,请重新打包后上传', { cause: e })
  }
  const names = Object.keys(files)
  if (!names.length) {
    throw new Error('压缩包内没有文件')
  }
  const entries = names.map((name) => {
    const bytes = files[name] ?? new Uint8Array(0)
    // 目录条目(以 / 结尾)或展开体积为 0 的条目按目录处理
    const isDirectory = name.endsWith('/') || bytes.length === 0
    return { name, size: bytes.length, isDirectory }
  })
  const hasSkillMd = entries.some(e => !e.isDirectory && /(^|\/)SKILL\.md$/i.test(e.name))
  if (!hasSkillMd) {
    throw new Error('压缩包内未找到 SKILL.md,请按标准 agent skill 格式打包(根目录含 SKILL.md)')
  }
  return { entries, hasSkillMd }
}

/** 计算分成(整数运算,避免浮点误差):卖家所得 = round(price*80%),平台 = price - 卖家所得 */
export function splitSkillPrice(price: number): { sellerShare: number, platformFee: number } {
  const sellerShare = Math.round(price * SELLER_RATIO)
  const platformFee = price - sellerShare
  return { sellerShare, platformFee }
}
