// scripts/make-encoding-fixtures.mts — 生成 GBK / Big5 / 二重乱码样例 txt(端到端测试用)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function range(from: number, to: number): number[] {
  const r: number[] = []
  for (let i = from; i <= to; i++) r.push(i)
  return r
}

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

const gbkMap = buildEncodeMap('gbk', range(0x81, 0xFE), [...range(0x40, 0x7E), ...range(0x80, 0xFE)])
const big5Map = buildEncodeMap('big5', range(0xA1, 0xF9), [...range(0x40, 0x7E), ...range(0xA1, 0xFE)])

const text = '第一章 初雪\n夜色沉沉,他推门而入,一身寒气。「你来了。」她低声说:这是小说,我们中间的世界,人生所有前进的时光都会好。\nThe quick brown fox. 12345\n'
const body = text.repeat(60)

const dir = join(import.meta.dirname!, '..', '.tmp-enc-test')
mkdirSync(dir, { recursive: true })

// GBK
writeFileSync(join(dir, 'sample-gbk.txt'), encodeWithMap(body, gbkMap))
// Big5(繁体)
const trad = '夜色沉沉,他推門而入,一身的寒氣。「你來了。」她低聲說。這是中間的學生,人生會好。\n'
writeFileSync(join(dir, 'sample-big5.txt'), encodeWithMap(trad.repeat(60), big5Map))
// 二重乱码:UTF-8 字节按 Latin-1 展开后重存 UTF-8
const original = new TextEncoder().encode(body)
writeFileSync(join(dir, 'sample-double-mojibake.txt'), new TextEncoder().encode(
  Array.from(original, b => String.fromCharCode(b)).join('')
))
// UTF-8 基准(期望与 GBK 解码内容一致,用于比对转换结果)
writeFileSync(join(dir, 'sample-utf8.txt'), original)
console.log('fixtures written to', dir)
