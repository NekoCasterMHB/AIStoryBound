// shared/announcement.ts
// 公告:常量、类型与输入校验(浏览器 / 服务器共用)。
// 公告存 D1(announcements 表),管理员在后台维护;客户端弹窗展示未读公告,
// 用户勾选「有新公告前不再提示」后,localStorage 记录已读游标(最新公告的 createdAt),
// 之后仅当出现 createdAt 更大的新公告时才再次弹出。
import { uuid } from './novel'

/** 公告标题字数上限 */
export const MAX_ANNOUNCEMENT_TITLE_CHARS = 60
/** 公告内容字数上限(markdown 原文) */
export const MAX_ANNOUNCEMENT_CONTENT_CHARS = 5000

/** 公告项(公开字段;published 仅管理端使用) */
export interface AnnouncementItem {
  id: string
  title: string
  /** markdown 内容 */
  content: string
  /** 1=已发布 | 0=草稿/下线 */
  published: boolean
  createdAt: number
  updatedAt: number
}

/** 管理端新建/编辑公告的输入 */
export interface AnnouncementInput {
  title: string
  content: string
  published: boolean
}

/** 校验公告标题/内容(trim 后校验长度),返回处理后的值;非法抛 Error 面向用户提示 */
export function normalizeAnnouncementInput(
  rawTitle: unknown,
  rawContent: unknown,
  rawPublished: unknown
): AnnouncementInput {
  const title = String(rawTitle ?? '').trim()
  const content = String(rawContent ?? '').trim()
  if (!title) {
    throw new Error('请填写公告标题')
  }
  if (title.length > MAX_ANNOUNCEMENT_TITLE_CHARS) {
    throw new Error(`标题不能超过 ${MAX_ANNOUNCEMENT_TITLE_CHARS} 字`)
  }
  if (!content) {
    throw new Error('请填写公告内容')
  }
  if (content.length > MAX_ANNOUNCEMENT_CONTENT_CHARS) {
    throw new Error(`内容不能超过 ${MAX_ANNOUNCEMENT_CONTENT_CHARS} 字`)
  }
  return { title, content, published: rawPublished === true || rawPublished === 1 }
}

/** 生成公告 id */
export function newAnnouncementId(): string {
  return uuid()
}
