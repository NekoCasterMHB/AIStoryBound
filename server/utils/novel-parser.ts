// server/utils/novel-parser.ts
// 小说解析核心(方案 C):编码检测 → 文本清洗 → 章节切分
// 未来切 Queues(方案 B)时,此函数作为消费者 worker 的主逻辑复用
import { detectEncoding, segmentChapters } from '../../shared/novel'
import type { ChapterSegment } from '../../shared/novel'

export interface ParseResult {
  encoding: string
  title: string
  chapters: ChapterSegment[]
  totalChars: number
}

/**
 * 解析 TXT 原始字节。
 * @param bytes 原始文件字节
 * @param filename 上传文件名(用于推断标题)
 */
export function parseNovelBytes(bytes: Uint8Array, filename: string): ParseResult {
  const encoding = detectEncoding(bytes)
  const text = new TextDecoder(encoding).decode(bytes)

  // 简单清洗:去掉 \r、合并连续空行
  const cleaned = text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')

  const chapters = segmentChapters(cleaned)
  // 标题按原始文件名(去掉 .txt)
  const title = filename.replace(/\.(txt|text)$/i, '')

  return { encoding, title, chapters, totalChars: cleaned.length }
}
