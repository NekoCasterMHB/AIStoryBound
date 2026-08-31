import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  billedTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  finalizeStreamUsage,
  mergeTokenUsage,
  normalizeTokenUsage
} from './token-estimate'

test('normalizeTokenUsage: OpenAI 字段完整时保持 prompt+completion', () => {
  const u = normalizeTokenUsage({ prompt_tokens: 8000, completion_tokens: 2000, total_tokens: 10000 })
  assert.deepEqual(u, { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 })
  assert.equal(billedTokens(u), 10000)
})

test('normalizeTokenUsage: total 只报输出时用 prompt+completion 抬高', () => {
  const u = normalizeTokenUsage({ prompt_tokens: 8000, completion_tokens: 2000, total_tokens: 2000 })
  assert.deepEqual(u, { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 })
})

test('normalizeTokenUsage: 认 input_tokens/output_tokens 别名', () => {
  const u = normalizeTokenUsage({ input_tokens: 1200, output_tokens: 300 })
  assert.deepEqual(u, { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 })
})

test('normalizeTokenUsage: camelCase 与缺 total', () => {
  const u = normalizeTokenUsage({ promptTokens: 10, completionTokens: 5 })
  assert.equal(u.totalTokens, 15)
})

test('normalizeTokenUsage: 别名组内取最大(矛盾字段不采信 0)', () => {
  const u = normalizeTokenUsage({ prompt_tokens: 0, input_tokens: 5000, completion_tokens: 200 })
  assert.deepEqual(u, { promptTokens: 5000, completionTokens: 200, totalTokens: 5200 })
})

test('normalizeTokenUsage: 字符串数字字段也能解析', () => {
  const u = normalizeTokenUsage({ prompt_tokens: '8000', completion_tokens: '2000', total_tokens: '10000' })
  assert.deepEqual(u, { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 })
})

test('mergeTokenUsage: 第一帧只有 prompt,流尾补 completion', () => {
  const first = normalizeTokenUsage({ prompt_tokens: 8000, total_tokens: 8000 })
  const last = normalizeTokenUsage({ completion_tokens: 2000, total_tokens: 2000 })
  const merged = mergeTokenUsage(first, last)
  assert.deepEqual(merged, { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 })
})

test('mergeTokenUsage: 后帧更大的 usage 覆盖偏小的第一帧', () => {
  const first = normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 })
  const last = normalizeTokenUsage({ prompt_tokens: 8000, completion_tokens: 2000, total_tokens: 10000 })
  const merged = mergeTokenUsage(first, last)
  assert.deepEqual(merged, { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 })
})

test('finalizeStreamUsage: 无 usage 时按 messages+输出估算', () => {
  const messages = [{ role: 'user', content: '你好世界' }]
  const u = finalizeStreamUsage(undefined, messages, '好的')
  assert.equal(u.promptTokens, estimateMessagesTokens(messages))
  assert.ok(u.completionTokens > 0)
  assert.equal(u.totalTokens, u.promptTokens + u.completionTokens)
})

test('finalizeStreamUsage: total=仅 completion 且缺 prompt 时补输入并入账', () => {
  const messages = [{ role: 'user', content: '这是一段足够长的中文输入用来估算 prompt token' }]
  const u = finalizeStreamUsage(
    { promptTokens: 0, completionTokens: 2000, totalTokens: 2000 },
    messages,
    '输出文本'
  )
  const estimatedPrompt = estimateMessagesTokens(messages)
  assert.equal(u.promptTokens, estimatedPrompt)
  assert.equal(u.completionTokens, 2000)
  assert.equal(u.totalTokens, estimatedPrompt + 2000)
  assert.ok(u.totalTokens > 2000)
})

test('finalizeStreamUsage: total 已含输入时不把估算 prompt 再加一遍', () => {
  const messages = [{ role: 'user', content: '这是一段足够长的中文输入用来估算 prompt token'.repeat(80) }]
  const estimatedPrompt = estimateMessagesTokens(messages)
  assert.ok(estimatedPrompt > 0)
  const u = finalizeStreamUsage(
    { promptTokens: 0, completionTokens: 2000, totalTokens: 10000 },
    messages,
    '输出文本'
  )
  assert.equal(u.promptTokens, estimatedPrompt)
  assert.equal(u.completionTokens, 2000)
  assert.equal(u.totalTokens, 10000)
  assert.equal(billedTokens(u), 10000)
})

test('finalizeStreamUsage: 只有 total 且接近输出估算时补输入', () => {
  const messages = [{ role: 'user', content: '这是一段足够长的中文输入用来估算 prompt token'.repeat(20) }]
  const output = '角色甲在房间里说话。'.repeat(30)
  const outputEst = estimateTextTokens(output)
  const u = finalizeStreamUsage(
    { totalTokens: outputEst },
    messages,
    output
  )
  const promptEst = estimateMessagesTokens(messages)
  assert.equal(u.promptTokens, promptEst)
  assert.equal(u.totalTokens, promptEst + outputEst)
})

test('finalizeStreamUsage: 只有 total 且远大于输出估算时不把输入再加一遍', () => {
  const messages = [{ role: 'user', content: '这是一段足够长的中文输入用来估算 prompt token'.repeat(20) }]
  const output = '好的'
  const u = finalizeStreamUsage(
    { totalTokens: 10000 },
    messages,
    output
  )
  assert.equal(u.totalTokens, 10000)
  assert.equal(billedTokens(u), 10000)
})

test('billedTokens: 缺 total 时回退 prompt+completion', () => {
  assert.equal(billedTokens({ promptTokens: 7, completionTokens: 3 }), 10)
  assert.equal(billedTokens({ totalTokens: 12, promptTokens: 7, completionTokens: 3 }), 12)
  assert.equal(billedTokens(null), 0)
})
