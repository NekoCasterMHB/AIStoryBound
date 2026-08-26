// shared/store-skill.ts
// Skill 商城:常量、类型与 zip 校验工具(浏览器 / 服务器共用)。
// 交易规则:买家按售价扣 token,卖家实得 售价*80%(直接进发布者余额),20% 平台手续费。
import { unzipSync } from 'fflate'
import * as yaml from 'js-yaml'

/** 卖家分成比例 */
export const SELLER_RATIO = 0.8
/** 平台手续费比例 */
export const PLATFORM_RATIO = 0.2

/** 单个 skill 压缩包大小上限(字节,10MB) */
export const MAX_SKILL_ZIP_BYTES = 10 * 1024 * 1024
/** 名称字数上限 */
export const MAX_SKILL_NAME_CHARS = 60
/** 单个标签字数上限 */
export const MAX_SKILL_TAG_CHARS = 12
/** 单个 skill 最多标签数 */
export const MAX_SKILL_TAGS = 6
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
  /** SKILL.md frontmatter 图标(emoji,可空) */
  icon: string | null
  /** SKILL.md frontmatter 标签(卡片展示) */
  tags: string[]
  /** 已上架版本(版本号倒序;「获取技能」可切换,旧版本通过后保持可下载) */
  versions: { version: number, createdAt: number }[]
  /** 发布者手动指定的主版本;为空 = 最新已上架版本(商城展示快照来源,「获取技能」默认目标) */
  mainVersion: number | null
  /** SKILL.md 正文摘要(卡片说明区展示,取第一段正文) */
  readme: string
}

/** 一个已提交版本(「我的发布」内嵌;发布者可下载任意版本) */
export interface SkillVersionBrief {
  version: number
  name: string
  /** 标签(表单 + SKILL.md frontmatter 合并,卡片展示) */
  tags: string[]
  desc: string
  price: number
  status: SkillStatus
  rejectReason: string | null
  /** 1=启用 | 0=禁用(禁用版本用户侧隐藏) */
  enabled: number
  fileSize: number
  createdAt: number
}

/** 我发布的一条(商城「我的发布」) */
export interface MyPublishedSkill {
  id: string
  name: string
  /** 标签(最新版本,更新表单预填) */
  tags: string[]
  desc: string
  price: number
  status: SkillStatus
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
  /** 可下载的已上架版本列表(含购买版本与后续上架版本,带发布时间) */
  versions: { version: number, createdAt: number }[]
}

/**
 * 解析 zip 内容,返回文件清单(不读取正文)与 SKILL.md / README 文本。
 * 校验规则:必须是 fflate 可解压的 zip,且根目录含 SKILL.md(市面通用 agent skill 格式)。
 * README(根目录 README.md / README,大小写不敏感)用于商城说明区域展示,缺省不抛错,
 * 由发布接口按上架要求单独校验(老版本 zip 可能没有,安装流程仍需放行)。
 * 抛 Error 表示格式不合法,message 面向用户提示。
 */
export function parseSkillZip(data: Uint8Array): { entries: SkillFileEntry[], hasSkillMd: boolean, skillMd: string | null, readmeFile: string | null } {
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
  const skillMdName = names.find(n => /(^|\/)SKILL\.md$/i.test(n))
  const skillMd = skillMdName
    ? new TextDecoder().decode(files[skillMdName] ?? new Uint8Array(0)).slice(0, 500_000)
    : null
  const hasSkillMd = !!skillMdName
  if (!hasSkillMd) {
    throw new Error('压缩包内未找到 SKILL.md,请按标准 agent skill 格式打包(根目录含 SKILL.md)')
  }
  // 商城说明来源:根目录 README(README.md / 无扩展名 README,优先 .md)
  const readmeName = names.find(n => /^README\.md$/i.test(n)) ?? names.find(n => /^README$/i.test(n))
  const readmeFile = readmeName
    ? new TextDecoder().decode(files[readmeName] ?? new Uint8Array(0)).slice(0, 500_000)
    : null
  return { entries, hasSkillMd, skillMd, readmeFile }
}

/** 轻度脱标记(标题/引用/列表符号),用于商城说明区纯文本展示 */
function plainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .split('\n').map(l => l.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000)
}

/**
 * 从 SKILL.md 文本提取商城卡片展示元数据:
 * frontmatter 可选 icon(emoji 字符串)与 tags(数组或逗号分隔);
 * readme = 压缩包内 README 文件内容(上架必带,商城说明区域展示);未提供时回退 SKILL.md 正文。
 */
export function extractSkillMeta(md: string, readmeFile?: string | null): { icon: string | null, tags: string[], readme: string } {
  const body = md.replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)
  let icon: unknown = null
  let tags: unknown = null
  if (m) {
    try {
      const meta = yaml.load(m[1] ?? '') as Record<string, unknown> | null
      icon = meta?.icon
      tags = meta?.tags
    } catch {
      // frontmatter 非法时忽略扩展字段,正文仍可用
    }
  }
  const iconStr = typeof icon === 'string' ? icon.trim().slice(0, 20) : ''
  const rawTags = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(/[,，]/) : [])
  const tagList = rawTags
    .filter((t): t is string => typeof t === 'string' && !!t.trim())
    .map(t => t.trim().slice(0, MAX_SKILL_TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_SKILL_TAGS)
  // 说明 = README 文件内容(未传时回退 SKILL.md 正文,兼容旧调用)
  const raw = readmeFile !== undefined && readmeFile !== null
    ? readmeFile
    : (m ? body.slice(m[0].length) : body)
  const readme = plainText(raw)
  return { icon: iconStr || null, tags: tagList, readme }
}

/** 计算分成(整数运算,避免浮点误差):卖家所得 = round(price*80%),平台 = price - 卖家所得 */
export function splitSkillPrice(price: number): { sellerShare: number, platformFee: number } {
  const sellerShare = Math.round(price * SELLER_RATIO)
  const platformFee = price - sellerShare
  return { sellerShare, platformFee }
}

/**
 * 解析发布表单的标签输入(JSON 字符串数组,或逗号/空白分隔):trim、去重,
 * 单标签 ≤ MAX_SKILL_TAG_CHARS 字、最多 MAX_SKILL_TAGS 个。非法输入返回空数组。
 */
export function parseTagsInput(raw: string): string[] {
  if (!raw.trim()) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    list = raw.split(/[,，\s]+/)
  }
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    const clean = t.trim().slice(0, MAX_SKILL_TAG_CHARS)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= MAX_SKILL_TAGS) break
  }
  return out
}

/** 解析数据库 tags 列(JSON 字符串数组,损坏时按空处理) */
export function parseStoredTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const t = JSON.parse(raw)
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
