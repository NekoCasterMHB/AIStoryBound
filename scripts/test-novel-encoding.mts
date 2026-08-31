// scripts/test-novel-encoding.mts — 编码检测/归一化的离线自测(Node TextDecoder 全编码可用)
// 用法: npx tsx scripts/test-novel-encoding.mts
// 说明:Node 只能解码不能编码 GBK/Big5,这里先用 TextDecoder 反向扫描建立「字符→字节」映射表来构造样例。
import { detectNovelEncoding, normalizeNovelToUtf8 } from '../shared/novel-encoding'

/** 反向扫描建立编码映射表:对候选双字节逐一解码,记录 字符→字节序列 */
function buildEncodeMap(label: string, leads: number[], trails: number[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  const pair = new Uint8Array(2)
  for (const lead of leads) {
    for (const trail of trails) {
      pair[0] = lead
      pair[1] = trail
      try {
        const ch = new TextDecoder(label, { fatal: true }).decode(pair)
        if (ch.length === 1 && !map.has(ch) && ch.codePointAt(0)! > 0x7F) map.set(ch, [lead, trail])
      } catch { /* 非法组合跳过 */ }
    }
  }
  return map
}

/** 用映射表把文本编码为字节(缺映射字符抛错,便于发现样例文本选词不当) */
function encodeWithMap(text: string, map: Map<string, number[]>): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) {
      out.push(c)
      continue
    }
    const b = map.get(ch)
    if (!b) throw new Error(`映射表缺字: ${ch}`)
    out.push(...b)
  }
  return new Uint8Array(out)
}

// 全 GBK 空间:lead 81-FE / trail 40-FE(排除 7F);Big5 lead A1-F9 / trail 40-7E + A1-FE
const gbkMap = buildEncodeMap('gbk', range(0x81, 0xFE), [...range(0x40, 0x7E), ...range(0x80, 0xFE)])
const big5Map = buildEncodeMap('big5', range(0xA1, 0xF9), [...range(0x40, 0x7E), ...range(0xA1, 0xFE)])

function range(from: number, to: number): number[] {
  const r: number[] = []
  for (let i = from; i <= to; i++) r.push(i)
  return r
}

const sample = '第一章 初雪\n夜色沉沉,他推门而入,帶著一身的寒氣。「你來了。」她低聲說。\nThe quick brown fox jumps over the lazy dog. 12345\n'.repeat(20)

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

console.log('1) UTF-8 无 BOM:')
{
  const r = detectNovelEncoding(new TextEncoder().encode(sample))
  check('识别为 utf-8', r.encoding === 'utf-8', r.encoding)
  check('高置信', r.confidence === 'high')
  check('文本一致', r.text === sample)
}

console.log('2) UTF-8 带 BOM:')
{
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(sample)])
  const r = detectNovelEncoding(bytes)
  check('识别为 utf-8', r.encoding === 'utf-8', r.encoding)
  check('BOM 已剥', !r.text.startsWith('\uFEFF'))
}

console.log('3) UTF-16LE 带 BOM:')
{
  const out = new Uint8Array(2 + [...sample].length * 2)
  out[0] = 0xFF
  out[1] = 0xFE
  let i = 2
  for (const ch of sample) {
    const c = ch.codePointAt(0)!
    out[i++] = c & 0xFF
    out[i++] = c >> 8
  }
  const r = detectNovelEncoding(out)
  check('识别为 utf-16le', r.encoding === 'utf-16le', r.encoding)
  check('文本一致', r.text === sample)
}

console.log('4) GBK 编码:')
{
  const bytes = encodeWithMap(sample, gbkMap)
  const r = detectNovelEncoding(bytes)
  check('识别为 GB 系(gbk/gb18030)', r.encoding === 'gbk' || r.encoding === 'gb18030', r.encoding)
  check('高置信', r.confidence === 'high', String(r.garbledRatio))
  check('解码含「第一章」', r.text.includes('第一章'))
  const norm = normalizeNovelToUtf8(bytes)
  const r2 = detectNovelEncoding(norm.bytes)
  check('归一化后识别为 utf-8', r2.encoding === 'utf-8', r2.encoding)
  check('归一化内容一致', r2.text === r.text)
}

console.log('5) Big5 编码(繁体):')
{
  // 简体字映射表里没有的繁体字样例改用映射表内必然存在的字构造
  const tradSample = '夜色沉沉,他推門而入,一身的寒氣。「你來了。」她低聲說。這是中間的學生,人生會好。\n'
  const bytes = encodeWithMap(tradSample.repeat(20), big5Map)
  const r = detectNovelEncoding(bytes)
  const info = `${r.encoding} ratio=${r.garbledRatio.toFixed(3)}`
  check('识别为 big5', r.encoding === 'big5', info)
  check('高置信', r.confidence === 'high', info)
  check('解码含「推門而入」', r.text.includes('推門而入'), info)
  const norm = normalizeNovelToUtf8(bytes)
  const r2 = detectNovelEncoding(norm.bytes)
  check('归一化后识别为 utf-8', r2.encoding === 'utf-8', r2.encoding)
  check('归一化内容一致', r2.text === r.text)
}

console.log('6) 二重乱码(UTF-8 文本被按 Latin-1 误转存):')
{
  // 原文 UTF-8 字节 → 每字节当作 Latin-1 字符 → 重新以 UTF-8 保存(典型乱码文件)
  const original = new TextEncoder().encode(sample)
  const mojibake = new TextEncoder().encode(
    Array.from(original, b => String.fromCharCode(b)).join('')
  )
  const r = detectNovelEncoding(mojibake)
  check('识别为 utf-8-recovered', r.encoding === 'utf-8-recovered', r.encoding)
  check('恢复原文', r.text === sample)
  const norm = normalizeNovelToUtf8(mojibake)
  check('归一化后即合法 UTF-8 且内容等于原文', new TextDecoder('utf-8', { fatal: true }).decode(norm.bytes) === sample)
}

console.log('7) 纯 ASCII 文本:')
{
  const text = 'Hello world. This is a plain ASCII novel file.\n'.repeat(30)
  const r = detectNovelEncoding(new TextEncoder().encode(text))
  check('识别为 utf-8', r.encoding === 'utf-8', r.encoding)
  check('高置信', r.confidence === 'high')
}

console.log('8) 真乱码(随机字节)不抛错且给出低置信:')
{
  const bytes = new Uint8Array(4096)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  const r = detectNovelEncoding(bytes)
  check('返回非空预览文本', typeof r.text === 'string' && r.text.length > 0)
  console.log(`    → encoding=${r.encoding} confidence=${r.confidence} ratio=${r.garbledRatio.toFixed(3)}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
