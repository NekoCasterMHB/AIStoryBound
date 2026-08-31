// shared/token-estimate.ts
// 字符 → token 估算(浏览器/服务器共用,零框架依赖)。
// 用于生成前预检与流式进行中的实时消耗展示,收尾始终以流尾真实 usage 为准。
// 中文字符按 CJK_TOKEN_PER_CHAR 折算:实测主流中文 tokenizer 约 1 汉字 ≈ 0.6~0.9 token
// (DeepSeek ≈ 0.6,Qwen/GLM ≈ 0.6-0.7,GPT-4o ≈ 0.8-1.0,Claude ≈ 0.7),
// 系数取略偏保守的 0.7(宁高勿低,但不再像旧值 1.3 那样高估约一倍)。
// 非 CJK 字符按 4 字符 1 token(英文惯例)。

/** 单个 CJK 字符折算的 token 数(上游为 LLaMA 系等中文压缩差的模型可上调) */
export const CJK_TOKEN_PER_CHAR = 0.7
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

/** 上游 SSE / 非流式 usage 的常见字段别名(OpenAI chat + Anthropic/Responses) */
export interface RawModelUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/** 归一化后的用量(扣费与展示都用这三项) */
export interface NormalizedTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

function nonNegInt(v: unknown): number {
  // 数字或数字字符串(部分网关把 usage 字段当字符串返回)都接受
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n))
}

/**
 * 把上游 usage 收成 prompt/completion/total。
 * 网关偶尔把 total_tokens 报成只含一边,或用 input_tokens/output_tokens:
 * total 取 reported 与 prompt+completion 的较大值,避免漏计输入或输出。
 */
export function normalizeTokenUsage(raw: RawModelUsage | null | undefined): NormalizedTokenUsage {
  if (!raw) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const promptTokens = Math.max(
    nonNegInt(raw.promptTokens),
    nonNegInt(raw.prompt_tokens),
    nonNegInt(raw.input_tokens)
  )
  const completionTokens = Math.max(
    nonNegInt(raw.completionTokens),
    nonNegInt(raw.completion_tokens),
    nonNegInt(raw.output_tokens)
  )
  const reportedTotal = Math.max(nonNegInt(raw.totalTokens), nonNegInt(raw.total_tokens))
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(reportedTotal, promptTokens + completionTokens)
  }
}

/** 跨 SSE 分片合并:各字段取更大值(第一帧常只有 prompt,流尾才有 completion) */
export function mergeTokenUsage(
  a: { promptTokens?: number, completionTokens?: number, totalTokens?: number } | undefined,
  b: { promptTokens?: number, completionTokens?: number, totalTokens?: number }
): NormalizedTokenUsage {
  const promptTokens = Math.max(a?.promptTokens ?? 0, b.promptTokens ?? 0)
  const completionTokens = Math.max(a?.completionTokens ?? 0, b.completionTokens ?? 0)
  const totalTokens = Math.max(a?.totalTokens ?? 0, b.totalTokens ?? 0, promptTokens + completionTokens)
  return { promptTokens, completionTokens, totalTokens }
}

/** 实际扣费/入账 token 数:优先 total,缺省用 prompt+completion */
export function billedTokens(usage: { promptTokens?: number, completionTokens?: number, totalTokens?: number } | null | undefined): number {
  if (!usage) return 0
  const total = nonNegInt(usage.totalTokens)
  const sum = nonNegInt(usage.promptTokens) + nonNegInt(usage.completionTokens)
  return total || sum
}

/**
 * 流结束时定稿。无 usage 则按 messages+输出估算;
 * 只报了一边(prompt=0 或 completion=0)时用估算补缺,再让 total ≥ prompt+completion。
 */
export function finalizeStreamUsage(
  usage: { promptTokens?: number, completionTokens?: number, totalTokens?: number } | undefined,
  messages: { role: string, content: string }[],
  outputText: string
): NormalizedTokenUsage {
  if (!usage || billedTokens(usage) <= 0) {
    const promptTokens = estimateMessagesTokens(messages)
    const completionTokens = estimateTextTokens(outputText)
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
  }
  const reportedPrompt = nonNegInt(usage.promptTokens)
  const reportedCompletion = nonNegInt(usage.completionTokens)
  let totalTokens = nonNegInt(usage.totalTokens)
  const promptTokens = reportedPrompt > 0
    ? reportedPrompt
    : (messages.length > 0 ? estimateMessagesTokens(messages) : 0)
  const completionTokens = reportedCompletion > 0
    ? reportedCompletion
    : (outputText ? estimateTextTokens(outputText) : 0)
  if (reportedPrompt > 0 && reportedCompletion > 0) {
    // 两边都是上游实数:total 至少等于两者之和
    totalTokens = Math.max(totalTokens, reportedPrompt + reportedCompletion)
  } else if (reportedPrompt <= 0 && reportedCompletion > 0 && totalTokens <= reportedCompletion) {
    // total 看起来只含输出,把估算输入加进扣费
    totalTokens = promptTokens + reportedCompletion
  } else if (reportedCompletion <= 0 && reportedPrompt > 0 && totalTokens <= reportedPrompt) {
    totalTokens = reportedPrompt + completionTokens
  } else if (reportedPrompt <= 0 && reportedCompletion <= 0 && totalTokens > 0 && promptTokens > 0) {
    // 只有 total、没有拆分字段:仅当 total 不超过输出估算(即 total 不含输入)时才补输入,
    // 避免把「已含输入的正确 total」再算一遍输入(小输入大输出的聊天调用尤需保守)
    if (completionTokens > 0 && totalTokens <= completionTokens + 32) totalTokens = promptTokens + totalTokens
  }
  return { promptTokens, completionTokens, totalTokens }
}
