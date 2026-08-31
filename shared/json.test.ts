import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { extractJson } from './json'

test('extractJson: 正常 JSON 原样解析', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 })
})

test('extractJson: ```json 围栏内提取', () => {
  assert.deepEqual(extractJson('```json\n{"openings":[{"title":"t","scene":"s"}]}\n```'), {
    openings: [{ title: 't', scene: 's' }]
  })
})

test('extractJson: 剥离前导说明文字', () => {
  assert.deepEqual(extractJson('好的,以下是开场设定:\n{"openings":[]}'), { openings: [] })
})

test('extractJson: 尾随内容截断(tryParseAfter)', () => {
  assert.deepEqual(extractJson('{"a": 1} 以上是全部内容'), { a: 1 })
})

test('extractJson: max_tokens 截断补全(tryRepairTruncated)', () => {
  assert.deepEqual(extractJson('{"openings":[{"title":"开","scene":"她'), {
    openings: [{ title: '开', scene: '她' }]
  })
})

test('extractJson: 字符串内未转义双引号被修复(tryRepairInnerQuotes)', () => {
  assert.deepEqual(extractJson('{"scene": "她说"我爱你"然后转身"}'), {
    scene: '她说"我爱你"然后转身'
  })
})

test('extractJson: 未转义双引号与截断并存', () => {
  assert.deepEqual(extractJson('{"scene": "她说"你'), { scene: '她说"你' })
})

test('extractJson: 数组里多个开场的未转义引号', () => {
  assert.deepEqual(extractJson('[{"title":"t","scene":"她说"走"吧"}]'), [
    { title: 't', scene: '她说"走"吧' }
  ])
})

test('extractJson: 已转义 \\" 走正常解析路径,不被二次转义', () => {
  assert.deepEqual(extractJson('{"scene": "她说\\"你好\\""}'), { scene: '她说"你好"' })
})

test('extractJson: 纯前导文字无 JSON 返回 null', () => {
  assert.equal(extractJson('这不是 JSON,只是随便说的几句话'), null)
})
