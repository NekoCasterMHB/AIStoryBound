// app/utils/exportStory.ts
// 游戏会话导出为 TXT:自动剔除玩家行动气泡与选项等提示内容,仅保留旁白原文。
import type { LocalGame } from '#shared/novel'

/** 轻量清理:去掉标题/加粗/行内标记等记号,还原纯文本 */
function cleanNarratorText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/** 从消息流提取纯剧情文本(角色不为 user 的消息 = 旁白原文) */
export function storyTextFromMessages(messages: LocalGame['messages']): string {
  return messages
    .filter(m => m.role !== 'user')
    .map(m => cleanNarratorText(m.content))
    .filter(t => t.length > 0)
    .join('\n\n')
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '故事'
}

export interface ExportGameTxtArgs {
  title?: string
  playerName?: string
  chapter?: string | null
  messages: LocalGame['messages']
  /** 导出时间;缺省用当前时间 */
  at?: Date
}

/** 组装 TXT 全文(标题头 + 旁白正文) */
export function buildGameTxt(args: ExportGameTxtArgs): string {
  const { title, playerName, chapter, messages, at = new Date() } = args
  const head = [
    title ? `《${title}》` : '故事记录',
    playerName ? `扮演:${playerName}` : '',
    ...[chapter ? `章节:${chapter}` : ''],
    `导出时间:${at.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}`
  ].filter(Boolean).join('　')
  const body = storyTextFromMessages(messages)
  return body ? `${head}\n\n${body}\n` : head
}

/**
 * 下载游戏剧情为 TXT 文件;没有可导出的旁白内容时返回 false(调用方自行提示)。
 * 带 BOM 头,Windows 记事本也能正确识别 UTF-8 中文。
 */
export function downloadGameAsTxt(args: ExportGameTxtArgs): boolean {
  if (!storyTextFromMessages(args.messages)) return false
  const text = buildGameTxt(args)
  const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(args.title || '故事')}-${sanitizeFilename(args.playerName || '玩家')}.txt`
  a.click()
  URL.revokeObjectURL(url)
  return true
}
