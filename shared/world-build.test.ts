// 弧线归一化测试:beatIndex 段号约定校正(模型常按提示词里的 1 基 [段N] 输出,消费端按 0 基读)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyExtraction, mergeExtractions, normalizeCharacterArcs } from './world-build'
import type { StoryBeat } from './novel'

const beats: StoryBeat[] = [
  { index: 0, startChar: 0, label: '第1段', summary: '初遇', cast: ['林清雪'] },
  { index: 1, startChar: 50, label: '第2段', summary: '同行', cast: ['林清雪', '陆沉'] },
  { index: 2, startChar: 120, label: '第3段', summary: '决裂', cast: ['林清雪'] }
]

test('normalizeCharacterArcs:1 基段号整体减一(末段不再被误判越界丢弃)', () => {
  const raw = {
    arcs: [{
      character: '林清雪',
      summary: '从初遇到决裂',
      beats: [
        { beatIndex: 1, summary: '初遇陆沉', status: '初识' },
        { beatIndex: 2, summary: '与他同行' },
        { beatIndex: 3, summary: '最终决裂' }
      ]
    }]
  }
  const out = normalizeCharacterArcs(raw, beats, [{ name: '林清雪' }])
  assert.deepEqual(out[0]!.beats.map(b => b.beatIndex), [0, 1, 2])
  assert.equal(out[0]!.beats[2]!.summary, '最终决裂')
  // status 不再入库:即使模型仍旧输出,归一化也丢弃(处境唯一真源是段文件 状态.处境)
  assert.equal(out[0]!.beats[0]!.status, undefined)
})

test('normalizeCharacterArcs:0 基段号原样保留', () => {
  const raw = {
    arcs: [{
      character: '林清雪',
      summary: '从初遇到决裂',
      beats: [
        { beatIndex: 0, summary: '初遇陆沉' },
        { beatIndex: 2, summary: '最终决裂' }
      ]
    }]
  }
  const out = normalizeCharacterArcs(raw, beats, [{ name: '林清雪' }])
  assert.deepEqual(out[0]!.beats.map(b => b.beatIndex), [0, 2])
})

test('normalizeCharacterArcs:登场段无法校验时不做段号换算(缺 cast 不误伤)', () => {
  const noCast: StoryBeat[] = beats.map(b => ({ ...b, cast: [] }))
  const raw = {
    arcs: [{
      character: '林清雪',
      summary: 'x',
      beats: [{ beatIndex: 1, summary: 'b' }]
    }]
  }
  const out = normalizeCharacterArcs(raw, noCast, [{ name: '林清雪' }])
  assert.deepEqual(out[0]!.beats.map(b => b.beatIndex), [1])
})

test('normalizeCharacterArcs:连续区间(投票打平)靠首段锚点判定 1 基', () => {
  // 登场段 6..9、模型输出 7..9:两种解释命中数相同,只有首段锚点能定案
  const late: StoryBeat[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({
    index: i, startChar: i * 10, label: `第${i + 1}段`, summary: 'x', cast: i >= 6 ? ['周权'] : ['封雅颂']
  }))
  const raw = {
    arcs: [{
      character: '周权',
      summary: 'x',
      beats: [
        { beatIndex: 7, summary: '首次见面' },
        { beatIndex: 8, summary: '同住' },
        { beatIndex: 9, summary: '结局' }
      ]
    }]
  }
  const out = normalizeCharacterArcs(raw, late, [{ name: '周权' }])
  assert.deepEqual(out[0]!.beats.map(b => b.beatIndex), [6, 7, 8])
})

test('normalizeCharacterArcs:越界段号丢弃、名字对齐人物卡', () => {
  const raw = {
    arcs: [{
      character: ' 林清雪 ',
      summary: 'x',
      beats: [
        { beatIndex: 0, summary: 'a' },
        { beatIndex: 99, summary: '越界' }
      ]
    }]
  }
  const out = normalizeCharacterArcs(raw, beats, [{ name: '林清雪' }])
  assert.equal(out[0]!.character, '林清雪')
  assert.deepEqual(out[0]!.beats.map(b => b.beatIndex), [0])
})

test('mergeExtractions:合并产物携带真实 mentionCount/sources,rule/hint/event 首选项回填', () => {
  const m = mergeExtractions([
    { chapter: 1, extract: { ...emptyExtraction(), characters: [{ name: '北柠' }], world_rules: [{ rule: '异国之人入关须有通关文牒', category: '社会规则' }], foreshadowing: [{ hint: '吊坠属男子' }], timeline_events: [{ event: '北柠坠入黑暗' }] } },
    { chapter: 2, extract: { ...emptyExtraction(), characters: [{ name: '北柠' }, { name: '石勇' }], world_rules: [{ rule: '异国之人入关须有通关文牒', category: '社会规则' }], foreshadowing: [{ hint: '吊坠属男子' }], timeline_events: [{ event: '北柠坠入黑暗', time: '傍晚' }] } }
  ])
  const rule = m.entities.world_rules[0]!
  assert.equal(rule.rule, '异国之人入关须有通关文牒')
  assert.ok(rule.mentionCount >= 2, `规则计数应 ≥2,实际 ${rule.mentionCount}`)
  assert.ok(rule.sources.length >= 2)
  const f = m.entities.foreshadowing[0]!
  assert.equal(f.hint, '吊坠属男子')
  assert.ok(f.mentionCount >= 2)
  const ev = m.entities.timeline_events[0]!
  assert.equal(ev.event, '北柠坠入黑暗')
  assert.equal(ev.time, '傍晚')
  const c = m.entities.characters.find(x => x.name === '北柠')!
  assert.equal(c.mentionCount, 2)
  // 旧字段 name 保留(历史消费方/旧档兼容)
  assert.equal(rule.name, '异国之人入关须有通关文牒')
})
