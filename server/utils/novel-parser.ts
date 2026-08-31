// server/utils/novel-parser.ts
// 小说解析核心:编码检测 → 文本清洗 → 单段全文(不再按章节切分,提取管线按字数分块)
// 未来切 Queues(方案 B)时,此函数作为消费者 worker 的主逻辑复用
import { detectNovelEncoding } from '../../shared/novel-encoding'

export interface ParseResult {
  encoding: string
  title: string
  text: string
  totalChars: number
}

/**
 * 解析 TXT 原始字节。
 * @param bytes 原始文件字节
 * @param filename 上传文件名(用于推断标题)
 */
export function parseNovelBytes(bytes: Uint8Array, filename: string): ParseResult {
  // 检测编码并直接取解码结果(返回值可能来自二重乱码修复通道,不是合法的 TextDecoder 标签)
  const detected = detectNovelEncoding(bytes)
  const encoding = detected.encoding
  const text = detected.text

  // 简单清洗:去掉 \r、合并连续空行
  const cleaned = text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // 标题按原始文件名(去掉 .txt)
  const title = filename.replace(/\.(txt|text)$/i, '')

  return { encoding, title, text: cleaned, totalChars: cleaned.length }
}
