// 生成管线 v2 打包测试(docs/format-v2.md §3.0/§6.2):标转折归一 + BookDoc 打包
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBookDoc, normalizeSegmentAnnotations, buildAnnotateMessages } from './book-build'
import type { CharacterArc, CharacterCard, StoryBeat, WorldOverlay } from './novel'

const beats: StoryBeat[] = [
  { index: 0, startChar: 0, label: '第1段', summary: '受命送文件', cast: ['何清玲', '林凡'] },
  { index: 1, startChar: 50, label: '第2段', summary: '绊倒散落物品', cast: ['何清玲'] },
  { index: 2, startChar: 120, label: '第3段', summary: '再次相见', cast: ['何清玲', '林凡'] }
]

const extracts = [
  { characters: [{ name: '何清玲', status: '接文件,被逗笑', plot: '何清玲接过文件被冒失的来人逗笑,顺手登记了信息' }, { name: '林凡', status: '冒失跑腿', plot: '林凡受命送文件,冒失撞翻了登记簿' }] },
  { characters: [{ name: '何清玲', status: '整理散落物品', plot: '她弯腰整理散落的物品,与来人攀谈起来' }] },
  { characters: [{ name: '何清玲', status: '主动约复习', plot: '她主动约对方周末一起去图书馆复习' }, { name: '林凡', status: null, plot: null }] }
]

test('normalizeSegmentAnnotations:合法分组保留,非法/跳跃/重叠降级为单粗段', () => {
  const raw = {
    segments: [
      { beats: [0, 1], title: '相识期', protagonists: ['何清玲'], nodes: ['受命', '绊倒', '离开'] },
      { beats: [2], title: '恋爱期', protagonists: ['路人甲'], nodes: ['偶遇'] },
      { beats: [1, 2], title: '重叠组' },
      { beats: [5], title: '越界' },
      { beats: [2, 4], title: '不连续' }
    ]
  }
  const out = normalizeSegmentAnnotations(raw, beats)
  // [0,1] 组 + [2] 组;越界/重叠/不连续组丢弃 → 段2 已在 [2] 组,无兜底重复
  assert.equal(out.length, 2)
  assert.deepEqual(out[0]!.beats, [0, 1])
  assert.equal(out[0]!.title, '相识期')
  assert.deepEqual(out[1]!.beats, [2])
  // 主角「路人甲」不在 cast 池 → 丢弃
  assert.equal(out[1]!.protagonists, undefined)
})

test('normalizeSegmentAnnotations:完全无有效分组 → 一粗段一段兜底', () => {
  const out = normalizeSegmentAnnotations({ segments: null }, beats)
  assert.equal(out.length, 3)
  const out2 = normalizeSegmentAnnotations(undefined, beats)
  assert.equal(out2.length, 3)
})

test('buildBookDoc:标转折合并剧情段,正典带标题/主角/节点,正文跨粗段切片', () => {
  const annotations = normalizeSegmentAnnotations({
    segments: [
      { beats: [0, 1], title: '相识期', protagonists: ['何清玲'], nodes: ['受命送文件', '绊倒交谈', '离开资料室'] },
      { beats: [2], title: '恋爱期', nodes: ['偶遇'] }
    ]
  }, beats)
  const fulltext = 'A'.repeat(50) + 'B'.repeat(70) + 'C'.repeat(30)
  const doc = buildBookDoc({ title: '测试', fulltext, storyline: beats, extracts, overlay: null, annotations })
  const segs = Object.values(doc.segments)
  assert.equal(segs.length, 2)
  // 段 0:合并粗段 0+1,正文 = 全文前 120 字(跨两段)
  assert.equal(segs[0]!.canon.title, '相识期')
  assert.deepEqual(segs[0]!.canon.主角, ['何清玲'])
  assert.equal(segs[0]!.canon.节点?.length, 3)
  assert.equal(segs[0]!.canon.节点?.[0]?.n, 0)
  assert.deepEqual(segs[0]!.canon.cast, ['何清玲', '林凡'])
  assert.equal(segs[0]!.canon.beat, '受命送文件;绊倒散落物品')
  assert.equal(segs[0]!.canon.text.length, 120)
  // 段 1:单粗段,正文到结尾
  assert.equal(segs[1]!.canon.title, '恋爱期')
  assert.equal(segs[1]!.canon.text, 'C'.repeat(30))
  // manifest 计数
  assert.equal(doc.manifest.segmentCount, 2)
})

test('buildBookDoc:段角色文件取该段内最后一条非空状态,空壳不落盘', () => {
  // 无标注 → 一粗段一段
  const doc = buildBookDoc({ title: '测试', fulltext: 'abc', storyline: beats, extracts, overlay: null })
  const segs = Object.values(doc.segments)
  assert.equal(segs[0]!.characters['何清玲']?.['状态']?.['处境'], '接文件,被逗笑')
  assert.equal(segs[0]!.characters['林凡']?.['状态']?.['处境'], '冒失跑腿')
  assert.match(String(segs[0]!.characters['何清玲']?.['剧情'] ?? ''), /逗笑|整理|登记/)
  assert.match(String(segs[0]!.characters['林凡']?.['剧情'] ?? ''), /送文件/)
  // 只有剧情没有状态:也建文件(空壳=状态与剧情皆空,§11.4)
  const plotOnly = buildBookDoc({
    title: 't',
    fulltext: 'x',
    storyline: [{ index: 0, startChar: 0, label: 'a', summary: 'a', cast: ['角色A'] }],
    extracts: [{ characters: [{ name: '角色A', status: null, plot: '她做了某事' }] }],
    overlay: null
  })
  assert.equal(plotOnly.segments['000']!.characters['角色A']?.['剧情'], '她做了某事')
  assert.equal(plotOnly.segments['000']!.characters['角色A']?.['状态'], undefined)
  assert.equal(segs[1]!.characters['何清玲']?.['状态']?.['处境'], '整理散落物品')
  // 粗段2:林凡状态为 null → 不建文件(空壳不落盘,§11.4)
  assert.equal(segs[2]!.characters['何清玲']?.['状态']?.['处境'], '主动约复习')
  assert.equal(segs[2]!.characters['林凡'], undefined)
})

test('buildBookDoc:成书卡经代码翻译为中文保留键,弧线权威在 world.characterArcs', () => {
  const cards: CharacterCard[] = [
    { name: '何清玲', role: '主角', identity: '学生', personality: ['认真'] },
    { name: '林凡', role: '配角', personality: [] }
  ]
  const overlay: WorldOverlay = { title: '成书标题', characters: cards, tags: ['测试'], heat: '淡' }
  const arcs: CharacterArc[] = [{
    character: '何清玲',
    summary: '从学生到伴侣的成长线',
    beats: [{ beatIndex: 0, summary: '接文件', status: '初识' }],
    ending: '在一起'
  }]
  const doc = buildBookDoc({ title: '测试', fulltext: 'x', storyline: beats, extracts, overlay, world: { characterArcs: arcs } })
  const he = doc.characters['何清玲']!
  assert.equal(he['身份'], '学生')
  assert.deepEqual(he['性格'], ['认真'])
  assert.equal(he['弧线'], undefined) // 「弧线」字段已废除:world.characterArcs 为唯一权威(§11.1)
  assert.equal(doc.world?.characterArcs?.[0]?.ending, '在一起')
  // manifest 来自 overlay meta
  assert.equal(doc.manifest.title, '成书标题')
  assert.deepEqual(doc.manifest.tags, ['测试'])
  assert.equal(doc.manifest.format, 'aisb-book')
  assert.equal(doc.manifest.charCount, 2)
})

test('buildAnnotateMessages:给出分块粗段与输出 schema 说明', () => {
  const { system, user } = buildAnnotateMessages('书名', beats.map(b => ({ index: b.index, label: b.label, summary: b.summary, cast: b.cast })))
  assert.match(system, /JSON/)
  assert.match(user, /剧情段/)
  assert.match(user, /段0:/)
  assert.match(user, /nodes/)
})
