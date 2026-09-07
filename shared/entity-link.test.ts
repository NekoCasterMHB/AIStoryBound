// 提取质量增强测试:实体消歧(预聚类/AI 裁决解析/应用合并)+ 故事线相邻重复去重 + 标转折跨块上下文
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clusterCharacterCandidates, buildEntityLinkMessages, parseEntityLinkGroups, applyEntityMerges, MAX_LINK_CLUSTERS } from './entity-link'
import { assembleStoryline } from './world-build'
import { buildAnnotateMessages } from './book-build'
import type { MergedCharacter, ChapterExtraction } from './novel'
import type { ExtractUnit } from './world-build'

function char(partial: Partial<MergedCharacter>): MergedCharacter {
  return { name: '无名', mentionCount: 0, sources: [], ...partial }
}

test('clusterCharacterCandidates:昵称/包含成簇,性别互斥与无关名不成簇', () => {
  const chars = [
    char({ name: '林凡', gender: '男', mentionCount: 30 }),
    char({ name: '小凡', gender: '男', mentionCount: 4 }), // 小+凡 ↔ 林凡末字
    char({ name: '凡哥', gender: '男', mentionCount: 2 }), // 凡+哥 ↔ 林凡末字
    char({ name: '林凡然', gender: '男', mentionCount: 5 }), // 包含「林凡」→ 同簇
    char({ name: '陈默', gender: '男', mentionCount: 20 }), // 无关
    char({ name: '小陈', gender: '女', mentionCount: 3 }) // 昵称匹配但性别互斥 → 不并
  ]
  const clusters = clusterCharacterCandidates(chars)
  const clusterOf = (name: string) => clusters.find(c => c.includes(chars.findIndex(x => x.name === name)))
  const lin = clusterOf('林凡')!
  assert.ok(lin, '林凡应有簇')
  assert.ok(lin.includes(chars.findIndex(x => x.name === '小凡')), '小凡并入')
  assert.ok(lin.includes(chars.findIndex(x => x.name === '凡哥')), '凡哥并入')
  assert.ok(!lin.includes(chars.findIndex(x => x.name === '陈默')), '陈默不并入')
  assert.ok(!clusterOf('小陈'), '性别互斥不成簇')
  assert.ok(clusters.length <= MAX_LINK_CLUSTERS)
})

test('clusterCharacterCandidates:无相似对返回空', () => {
  assert.deepEqual(clusterCharacterCandidates([char({ name: '甲' }), char({ name: '乙' })]), [])
})

test('buildEntityLinkMessages:候选带画像,规则含宁漏勿错', () => {
  const chars = [char({ name: '林凡', gender: '男', mentionCount: 30, quote: '他跑得飞快' }), char({ name: '小凡', mentionCount: 2 })]
  const { system, user } = buildEntityLinkMessages('书名', chars, [0, 1])
  assert.match(system, /JSON/)
  assert.match(user, /"index":0/)
  assert.match(user, /宁漏勿错/)
  assert.match(user, /他跑得飞快/)
})

test('parseEntityLinkGroups:非法下标丢弃、重复取首次、未提及按独立;只返回多成员组', () => {
  const cluster = [0, 1, 2, 3]
  const raw = { groups: [[0, 2, 9], [1, 1], [3], 'x', [2]] }
  const groups = parseEntityLinkGroups(raw, cluster)
  // 0,2 成组(9 非法;2 重复归首次);1 未提及独立;3 单独组被过滤
  assert.deepEqual(groups, [[0, 2]])
})

test('applyEntityMerges:规范条目=提及最高,并集/求和/标量回落/变体归并', () => {
  const chars = [
    char({
      name: '小凡', mentionCount: 2, gender: '男',
      personality: ['冒失'], goals: ['送文件'],
      chapterVariants: [{ stage: 1, title: '第2段', status: '整理物品', patch: {} }]
    }),
    char({
      name: '林凡', mentionCount: 30, gender: '男', identity: '学生', background: '学习委员',
      alias: ['凡哥'], personality: ['冒失', '热心'], secrets: ['喜欢同桌'],
      chapterVariants: [{ stage: 1, title: '第2段', status: '被打屁股', patch: { identity: '男友' } }],
      relationships: [{ name: '何清玲', type: '同学' }]
    })
  ]
  const { characters, mergedAway } = applyEntityMerges(chars, [[0, 1]])
  assert.equal(mergedAway, 1)
  assert.equal(characters.length, 1)
  const c = characters[0]!
  assert.equal(c.name, '林凡', '提及最高者为规范条目')
  assert.equal(c.mentionCount, 32)
  assert.ok(c.alias?.includes('凡哥'))
  assert.ok(c.personality?.includes('热心') && c.personality?.length === 2, '性格去重并集')
  assert.ok(c.secrets?.includes('喜欢同桌'))
  assert.equal(c.identity, '学生')
  assert.equal(c.relationships?.length, 1)
  assert.equal(c.chapterVariants?.length, 1)
  assert.equal(c.chapterVariants?.[0]?.status, '被打屁股', '同段变体后写覆盖')
  // 原数组不被修改
  assert.equal(chars.length, 2)
})

test('assembleStoryline:相邻重叠区重复摘要合并进前一拍,非重复保留', () => {
  const unit = (i: number): ExtractUnit => ({ chapter: i + 1, label: `第${i + 1}段`, content: 'x'.repeat(50), startChar: i * 40 })
  const beat = (summary: string, cast: string[] = ['林凡']): ChapterExtraction =>
    ({ characters: [], locations: [], factions: [], timeline_events: [], world_rules: [], items: [], foreshadowing: [], plot_beat: { summary, cast } })
  const units = [unit(0), unit(1), unit(2)]
  const extracts = [
    beat('林凡受命去资料室送文件,路上撞翻了登记簿,被值班的何清玲记了大过'),
    beat('林凡受命去资料室送文件,路上撞翻了登记簿,被值班的何清玲记了大过'), // 与上一拍重复(重叠区)
    beat('何清玲主动约林凡周末去图书馆复习功课')
  ]
  const { storyline, gaps } = assembleStoryline(units, extracts)
  assert.equal(storyline.length, 2, '重复拍不单独成拍')
  assert.deepEqual(gaps, [])
  assert.equal(storyline[0]!.index, 0, '保留前拍下标(单元序)')
  assert.deepEqual(storyline[0]!.cast, ['林凡'], 'cast 相同去重')
  assert.equal(storyline[1]!.summary, '何清玲主动约林凡周末去图书馆复习功课')
})

test('buildAnnotateMessages:prevTail 注入背景衔接说明', () => {
  const beats = [{ index: 30, label: '第31段', summary: '再次相见', cast: ['何清玲'] }]
  const without = buildAnnotateMessages('书名', beats)
  assert.ok(!without.user.includes('背景'))
  const { user } = buildAnnotateMessages('书名', beats, { title: '相识期', summary: '林凡送文件时撞倒物品' })
  assert.match(user, /相识期/)
  assert.match(user, /林凡送文件时撞倒物品/)
  assert.match(user, /不要回头改写/)
})
