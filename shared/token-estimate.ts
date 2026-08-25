// shared/token-estimate.ts
// 字符 → token 估算(浏览器/服务器共用,零框架依赖)。
// 用于生成前预检与流式进行中的实时消耗展示,收尾始终以流尾真实 usage 为准。
// 中文字符按 CJK_TOKEN_PER_CHAR 折算:该系数取主流中文 tokenizer 的保守中位
// (DeepSeek/Qwen/GLM 约 1.0-1.3,GPT-4o 约 1.1,Claude 约 0.6,LLaMA/Mistral 约 1.5-2.0),
// 非 CJK 字符按 4 字符 1 token(英文惯例)。老版按 字符数/1.7 会把中文多的文本低估约 2 倍,
// 实时数字明显低于真实消耗,故改为分字符类折算、宁可略高估。

/** 单个 CJK 字符折算的 token 数(调高更保守,如上游为 LLaMA 系可上调) */
export const CJK_TOKEN_PER_CHAR = 1.3
/** 非 CJK 字符平均多少字符折算 1 token */
export const NON_CJK_CHARS_PER_TOKEN = 4

// 汉字 + 中日韩标点扩展 + 假名 + 谚文
const CJK_RE = /[\u{4E00}-\u{9FFF}\u{3400}-\u{4DBF}\u{F900}-\u{FAFF}\u{3000}-\u{303F}\u{FF00}-\u{FFEF}\u{3040}-\u{30FF}\u{AC00}-\u{D7AF}]/gu

/** 估算一段文本的 token 数:CJK 字符按 CJK_TOKEN_PER_CHAR,其余按 4 字符 1 token */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  return Math.ceil(cjk * CJK_TOKEN_PER_CHAR + (text.length - cjk) / NON_CJK_CHARS_PER_TOKEN)
}

/** 缺原文时按字数量直估(cjkCount 传全书字数;中文为主的口径) */
export function estimateCjkCountTokens(cjkCount: number, otherCount = 0): number {
  if (!Number.isFinite(cjkCount) || cjkCount <= 0) return 0
  return Math.ceil(cjkCount * CJK_TOKEN_PER_CHAR + Math.max(0, otherCount) / NON_CJK_CHARS_PER_TOKEN)
}

/** 估算一组消息的输入 token(每条消息的角色标签与 JSON 包装结构开销计 4 token) */
export function estimateMessagesTokens(messages: { role: string, content: string }[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  let sum = messages.length * 4
  for (const m of messages) sum += estimateTextTokens(m.content ?? '')
  return sum
}
