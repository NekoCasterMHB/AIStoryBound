// P6 兼容矩阵测试(docs/format-v2.md §9/§10 P6):v1↔v2 双向转换、zip 往返、异版本/空字段容忍。
// 覆盖矩阵:旧 work(v1 LocalWork 全字段)→ v2 → 回读 v1 的信息保真;book2 zip 字节级往返;
// 异版本怪字段(结构化对象/字符串数组混写)经解释器归一不崩;空字段作品不崩。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workToV2, v2ToWork } from '#shared/v2-convert'
import { bookDocToZip, bookZipToDoc } from './novel-v2'
import { characterCardToBook } from './normalize-card'
import { interpretCharacter, toText, toList } from './character-interpreter'
import type { CharacterCard, LocalWork, StoryBeat } from './novel'

function makeWork(): LocalWork {
  const cards: CharacterCard[] = [
    {
      name: '何清玲',
      role: '主角',
      gender: '女',
      alias: '学习委员',
      identity: '学生',
      appearance: '黑色长发',
      personality: ['认真', '有责任感'],
      background: '学习委员',
      goals: ['完成任务'],
      relationships: [{ name: '林凡', type: '同学', value: 30 }],
      patience: 60,
      softness: 80,
      desire: 40,
      dead: false,
      kinks: [{ theme: '打屁股', view: '接受', role: '承受', detail: null }]
    },
    { name: '林凡', role: '配角', personality: ['冒失'] }
  ]
  const storyline: StoryBeat[] = [
    { index: 0, startChar: 0, label: '第1段', summary: '受命送文件', cast: ['何清玲', '林凡'], place: '办公室' },
    { index: 1, startChar: 100, label: '第2段', summary: '资料室相遇', cast: ['何清玲'] }
  ]
  return {
    id: 'w1',
    title: '资料室之行',
    author: '佚名',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    chapters: [{ title: '', content: '正文第一部分。'.repeat(20) + '正文第二部分。'.repeat(20) }],
    syncStatus: 'local',
    worldFormat: 2,
    overlay: { title: '资料室之行', summary: '一个关于成长的故事', characters: cards, tags: ['校园'], orientation: '男女', heat: '淡', setting: '现实校园' },
    storyline,
    entities: {
      characters: [], locations: [], factions: [], timeline_events: [],
      world_rules: [{ category: '校园', rule: '资料室需登记', quote: null, sources: [], mentionCount: 1 }],
      items: [], foreshadowing: []
    },
    conflicts: [],
    characterArcs: [{
      character: '何清玲',
      summary: '从学生到伴侣的成长线',
      beats: [{ beatIndex: 0, summary: '接文件', status: '初识' }],
      ending: '在一起'
    }]
  }
}

test('兼容矩阵:v1 → v2 → v1 往返,人物卡/故事线/元数据保真', () => {
  const work = makeWork()
  const doc = workToV2(work)
  const back = v2ToWork(doc, { id: work.id })

  // 人物卡:保留键往返一致(基础字段 + 数值 + 嗜好 + 关系)
  const he = back.overlay?.characters?.find(c => c.name === '何清玲')
  assert.ok(he)
  assert.equal(he.role, '主角')
  assert.equal(he.identity, '学生')
  assert.equal(he.appearance, '黑色长发')
  assert.deepEqual(he.personality, ['认真', '有责任感'])
  assert.deepEqual(he.goals, ['完成任务'])
  assert.equal(he.patience, 60)
  assert.equal(he.softness, 80)
  assert.equal(he.desire, 40)
  assert.equal(he.kinks?.[0]?.theme, '打屁股')
  assert.equal(he.kinks?.[0]?.view, '接受')
  assert.equal(he.relationships?.[0]?.name, '林凡')
  assert.equal(he.relationships?.[0]?.value, 30)
  // 空卡(无身份/外貌)不生成空字段
  const lin = back.overlay?.characters?.find(c => c.name === '林凡')
  assert.ok(lin)
  assert.equal(lin.appearance, undefined)

  // 故事线:段数/摘要/cast 对齐(v2 回读 startChar 归零,由段正文代替)
  assert.equal(back.storyline?.length, 2)
  assert.equal(back.storyline?.[0]?.summary, '受命送文件')
  assert.deepEqual(back.storyline?.[0]?.cast, ['何清玲', '林凡'])

  // 元数据:manifest 往返
  assert.equal(back.title, '资料室之行')
  assert.equal(back.overlay?.summary, '一个关于成长的故事')
  assert.deepEqual(back.overlay?.tags, ['校园'])
  assert.equal(back.overlay?.heat, '淡')
  // 引擎派生数据随包(world.json):实体库/弧线往返无损(v2 单轨的功能不回退保障)
  assert.equal(back.entities?.world_rules?.[0]?.rule, '资料室需登记')
  assert.equal(back.characterArcs?.[0]?.summary, '从学生到伴侣的成长线')
  assert.equal(back.characterArcs?.[0]?.beats?.[0]?.beatIndex, 0)
  // 归档全文 = 切段前原文
  assert.ok(back.chapters[0]?.content.includes('正文第二部分'))
})

test('兼容矩阵:book2 zip 字节级往返(含节点/主角/自由键)', () => {
  const doc = workToV2(makeWork())
  doc.segments['000']!.canon.节点 = [{ n: 0, 事件: '受命送文件' }, { n: 1, 事件: '绊倒散落物品' }]
  doc.segments['000']!.canon.主角 = ['何清玲']
  const bc = doc.characters['何清玲']!
  bc['口头禅'] = '好的老师'
  bc['癖好细节'] = { 怕痒: true, 部位: '腰侧' }
  doc.segments['000']!.characters['何清玲'] = { 姓名: '何清玲', 剧情: '接过文件', 状态: { 身份: '学生' } }

  const bytes = bookDocToZip(doc)
  const back = bookZipToDoc(bytes)
  assert.equal(back.manifest.format, 'aisb-book')
  assert.deepEqual(back.segments['000']!.canon.节点, [{ n: 0, 事件: '受命送文件' }, { n: 1, 事件: '绊倒散落物品' }])
  assert.deepEqual(back.segments['000']!.canon.主角, ['何清玲'])
  assert.equal(back.characters['何清玲']?.['口头禅'], '好的老师')
  assert.deepEqual(back.characters['何清玲']?.['癖好细节'], { 怕痒: true, 部位: '腰侧' })
  assert.equal(back.segments['000']!.characters['何清玲']?.['剧情'], '接过文件')
  assert.equal((back.segments['000']!.characters['何清玲']?.['状态'] as Record<string, unknown>)?.['身份'], '学生')
})

test('兼容矩阵:异版本怪字段容忍(结构化对象/字符串性格),解释器归一不崩', () => {
  // 性格是字符串(契约约定 string[])、外貌是结构化对象(事故场景)
  const raw = characterCardToBook({
    name: '异版角色',
    role: '配角',
    personality: [],
    appearance: undefined,
    identity: '同学'
  } as CharacterCard)
  assert.ok(raw)
  ;(raw as Record<string, unknown>)['外貌'] = { 身高: '170cm', build: '瘦削' }
  ;(raw as Record<string, unknown>)['性格'] = '认真、倔强'
  const parsed = interpretCharacter(raw)
  assert.ok(parsed)
  // 结构化对象 → 展开为"键:值"描述,不崩
  assert.match(parsed.card.appearance ?? '', /身高:170cm/)
  assert.match(parsed.card.appearance ?? '', /build:瘦削/)
  // 字符串性格 → 拆为数组
  assert.deepEqual(parsed.card.personality, ['认真', '倔强'])
  // 工具函数直接测:数组混入非字符串、null/缺失
  assert.deepEqual(toList('a、b;c'), ['a', 'b', 'c'])
  assert.deepEqual(toList([1, 'x', null]), ['x'])
  assert.equal(toText(['长', '发']), '长；发')
  assert.equal(toText(null), null)
})

test('兼容矩阵:人物卡编辑写回(性别/年龄/多别名)不丢失', () => {
  // 编辑器保存路径:引擎卡 → characterCardToBook → 解释器读回;年龄/性别曾被消费不回写、多别名被折叠,此测试锁定修复
  const bc = characterCardToBook({
    name: '何清玲', role: '主角', gender: '女', age: '约18岁',
    alias: '学习委员；玲玲', personality: []
  } as CharacterCard)
  assert.ok(bc)
  assert.equal(bc['性别'], '女')
  assert.equal(bc['年龄'], '约18岁')
  assert.deepEqual(bc['别名'], ['学习委员', '玲玲'])
  const parsed = interpretCharacter(bc)
  assert.ok(parsed)
  assert.equal(parsed.card.gender, '女')
  assert.equal(parsed.card.age, '约18岁')
  assert.equal(parsed.card.alias, '学习委员；玲玲')
  // 二次写回(编辑→保存→再编辑)保持稳定
  const bc2 = characterCardToBook(parsed.card)
  assert.deepEqual(bc2?.['别名'], ['学习委员', '玲玲'])
  // 无性别/年龄的卡不产生空字段;「未知」不落库
  const bare = characterCardToBook({ name: '空卡', role: '配角', personality: [], gender: '未知' } as CharacterCard)
  assert.ok(bare)
  assert.equal(bare['性别'], undefined)
  assert.equal(bare['年龄'], undefined)
  assert.equal(bare['别名'], undefined)
})

test('兼容矩阵:空字段作品(v2 空段/空角色/v1 无产物)不崩、结构完整', () => {
  // v2 空作品
  const back = v2ToWork(bookZipToDoc(bookDocToZip({
    manifest: { format: 'aisb-book', version: 2, kind: 'book', title: '空书', segmentCount: 0, charCount: 0 },
    fulltext: '',
    segments: {},
    characters: {}
  })), { id: 'empty' })
  assert.equal(back.title, '空书')
  assert.equal(back.overlay?.characters, undefined)
  assert.equal(back.storyline, undefined)
  // v1 无 storyline → workToV2 走按字数退路切段
  const work = makeWork()
  work.storyline = undefined
  work.overlay!.characters = []
  const doc = workToV2(work)
  assert.ok(Object.keys(doc.segments).length > 0)
  assert.equal(doc.manifest.charCount, 0)
  // 段正文非空(退路切段有效)
  const segs = Object.values(doc.segments)
  assert.ok(segs.every(s => s.canon.text.length > 0))
})
