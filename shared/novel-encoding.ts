// shared/novel-encoding.ts
// 小说 TXT 编码自动识别与 UTF-8 归一化(浏览器 / Cloudflare Workers 共用,纯 TextDecoder,无第三方依赖)。
// 背景:用户上传的 TXT 编码不一(UTF-8 / GBK / GB18030 / Big5 / UTF-16,还有「UTF-8 文本被按单字节
// 编码误转存」的二重乱码),直接按固定顺序解码会产生乱码。这里对每个候选解码结果按
// 「正常文本特征占比」评分后择优,而不是命中第一个可解码的编码就停。

/** 支持的来源编码标签(评分择优后的结果) */
export type NovelEncoding
  = | 'utf-8'
    | 'utf-16le'
    | 'utf-16be'
    | 'gb18030'
    | 'gbk'
    | 'big5'
    | 'utf-8-recovered'

export const NOVEL_ENCODING_LABELS: Record<NovelEncoding, string> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16LE',
  'utf-16be': 'UTF-16BE',
  'gb18030': 'GB18030',
  'gbk': 'GBK',
  'big5': 'Big5',
  'utf-8-recovered': 'UTF-8(二重转码已修复)'
}

/** 常用汉字集(简体 + 繁体高频字):正确解码的中文小说里这些字占绝大多数,错误解码则会大量落在生僻区 */
const COMMON_CJK = new Set(
  ('的一是了我不人在他有这中大来上国个到说们为子和你地出道也时年过就那要下以生自会家可后对行学发将前所进多如么去然心天好只没还种把作想成从看无事用第样面位手又回因其里被世长起已法间知它与性体军方前动电都量题政经其五解系进者情头明今后理正值点成立些主力气月明所本又用当定听白通立并处海之别老能动实金活门意变都水名利往士声乐总士机变器相边花放位个现边红承完书认部议记论变先半任达增三思究未真何反讲此指全务办流必器确取管被精志则研七序省眼区力各查难身出东识队白毛没半观约九久族六八七十百千万亿元角分钱块毛整'
    + '這個們來後國時說麼現見東車馬鳥語書學習開關門問間電電腦視圖書館館際際網絡運動員場廠歷歸報導體發應該當隨頭條業態務員優質價格買賣錢銀行貼適銷費裡週歲紀寫寶貴貴陽陽光榮譽證號碼碼頭樓層層級級別離開關鍵鍵盤盤點點擊擊敗敗壞壞處處理理論論壇壇城城市場設備備份份額額度度假假期期間間隔隔離離婚婚禮禮物物業業主主題題目目的的確確實實際際情情況況且且慢慢慢慢車車站站台')
    .split('')
)

interface Candidate {
  encoding: NovelEncoding
  /** 候选优先级(同分时先出现者胜;UTF-8 系优先于 GB 系优先于 Big5) */
  priority: number
  text: string
}

export interface NovelEncodingResult {
  encoding: NovelEncoding
  /** 展示用标签,如 UTF-8 / GBK / Big5 */
  label: string
  /** 按最优编码解码并剥掉 BOM 后的全文 */
  text: string
  /** 乱码特征字符(U+FFFD、控制符、生僻区符号等)占比,0~1 */
  garbledRatio: number
  /** high = 乱码特征占比 < 0.5%;low = 疑似乱码,建议人工确认 */
  confidence: 'high' | 'low'
}

function tryDecode(bytes: Uint8Array, label: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes)
  } catch {
    // 环境不支持该编码标签(如 Workers 无 big5)或严格解码失败
    return null
  }
}

/** 文本质量评分:返回乱码特征字符占比(越小越好) */
function garbledRatio(text: string): number {
  if (!text.length) return 1
  let bad = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 0xFFFD) {
      bad++
      continue
    }
    if (c < 0x80) {
      // 常规换行/制表之外的 ASCII 控制符视为乱码特征
      if ((c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) || c === 0x7F) bad++
      continue
    }
    if (COMMON_CJK.has(ch)) continue
    if ((c >= 0x4E00 && c <= 0x9FFF) // CJK 统一表意文字
      || (c >= 0x3000 && c <= 0x303F) // CJK 标点
      || (c >= 0xFF00 && c <= 0xFFEF) // 全角字符
      || (c >= 0x2010 && c <= 0x2027) // 常见破折号/引号/省略号区
      || (c >= 0x00A1 && c <= 0x00FF)) { // 拉丁补充(法语/拼音等)少量出现属正常
      continue
    }
    bad++
  }
  return bad / text.length
}

/** 候选清单:按优先级排列;UTF-16 仅在 BOM 命中时使用(无 BOM 不猜) */
function buildCandidates(bytes: Uint8Array): Candidate[] {
  const list: Candidate[] = []
  const push = (encoding: NovelEncoding, priority: number, text: string | null) => {
    if (text !== null) list.push({ encoding, priority, text })
  }

  // 严格 UTF-8:命中即原文
  push('utf-8', 0, tryDecode(bytes, 'utf-8', true))
  // GB 系:国内 TXT 最常见;gb18030 兼容 gbk 且覆盖四字节扩展
  push('gb18030', 1, tryDecode(bytes, 'gb18030', true))
  push('gbk', 2, tryDecode(bytes, 'gbk', true))
  // Big5:繁体 TXT;Workers 不支持该标签时自动跳过(转换仍可在浏览器端完成)
  push('big5', 3, tryDecode(bytes, 'big5', true))
  // 宽松 UTF-8 兜底(可能含 U+FFFD,但保证有预览文本)
  push('utf-8', 4, tryDecode(bytes, 'utf-8', false))

  // 二重乱码修复通道:「UTF-8 文本被按 Latin-1/单字节编码误转存」后,正文几乎全落在 0x80~0xFF。
  // 把这些字符的码点还原为字节再严格 UTF-8 解码,可恢复原文。
  const loose = tryDecode(bytes, 'utf-8', false)
  if (loose) {
    let latin = 0
    let total = 0
    for (const ch of loose) {
      const c = ch.codePointAt(0)!
      total++
      if (c === 0x0A || c === 0x0D || (c >= 0x20 && c <= 0xFF)) latin++
    }
    // 修复结果需与普通 UTF-8 解码不同(纯 ASCII 等场景恢复是恒等变换,无需标记)
    const plainUtf8 = loose.replace(/^\uFEFF/, '')
    if (total > 0 && latin / total > 0.7) {
      const recoveredBytes = new Uint8Array(loose.length)
      let n = 0
      for (const ch of loose) {
        const c = ch.codePointAt(0)!
        if (c <= 0xFF) recoveredBytes[n++] = c
      }
      const recovered = tryDecode(recoveredBytes.slice(0, n), 'utf-8', true)
      if (recovered !== null && recovered !== plainUtf8 && garbledRatio(recovered) < 0.005) {
        list.push({ encoding: 'utf-8-recovered', priority: -1, text: recovered })
      }
    }
  }
  return list
}

/**
 * 自动识别小说 TXT 编码并解码:BOM → 候选解码(严格 UTF-8 / GB18030 / GBK / Big5 / 宽松 UTF-8 /
 * 二重乱码修复)→ 按乱码特征占比择优。任何输入都会返回可预览文本(最坏为宽松 UTF-8 + low 置信)。
 */
export function detectNovelEncoding(bytes: Uint8Array): NovelEncodingResult {
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    const text = (tryDecode(bytes, 'utf-8', false) ?? '').replace(/^\uFEFF/, '')
    return { encoding: 'utf-8', label: NOVEL_ENCODING_LABELS['utf-8'], text, garbledRatio: 0, confidence: 'high' }
  }
  // UTF-16 BOM
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    const text = (tryDecode(bytes, 'utf-16le', false) ?? '').replace(/^\uFEFF/, '')
    return { encoding: 'utf-16le', label: NOVEL_ENCODING_LABELS['utf-16le'], text, garbledRatio: garbledRatio(text), confidence: 'high' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    const text = (tryDecode(bytes, 'utf-16be', false) ?? '').replace(/^\uFEFF/, '')
    return { encoding: 'utf-16be', label: NOVEL_ENCODING_LABELS['utf-16be'], text, garbledRatio: garbledRatio(text), confidence: 'high' }
  }

  // 择优:乱码占比最低者;打平(误差 1e-9)时取优先级更高者(UTF-8 系 > GB 系 > Big5,修复通道最优先)
  let best: Candidate | null = null
  let bestRatio = Number.POSITIVE_INFINITY
  for (const cand of buildCandidates(bytes)) {
    const ratio = garbledRatio(cand.text)
    if (
      !best
      || ratio < bestRatio - 1e-9
      || (ratio <= bestRatio + 1e-9 && cand.priority < best.priority)
    ) {
      best = cand
      bestRatio = ratio
    }
  }
  // buildCandidates 的宽松 UTF-8 兜底保证 list 非空
  const chosen = best!
  return {
    encoding: chosen.encoding,
    label: NOVEL_ENCODING_LABELS[chosen.encoding],
    text: chosen.text.replace(/^\uFEFF/, ''),
    garbledRatio: bestRatio,
    confidence: bestRatio < 0.005 ? 'high' : 'low'
  }
}

export interface NormalizedNovel {
  /** UTF-8 重编码后的字节(可直接入库/入 R2) */
  bytes: Uint8Array
  /** 来源编码标签 */
  sourceEncoding: NovelEncoding
  /** 解码后的全文(BOM 已剥) */
  text: string
}

/** 识别编码 → 解码 → 统一重编码为 UTF-8(内容不变,编码归一化) */
export function normalizeNovelToUtf8(bytes: Uint8Array): NormalizedNovel {
  const detected = detectNovelEncoding(bytes)
  return {
    bytes: new TextEncoder().encode(detected.text),
    sourceEncoding: detected.encoding,
    text: detected.text
  }
}
