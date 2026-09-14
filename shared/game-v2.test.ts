// 作品格式 v2 引擎读取层测试(见 docs/format-v2.md §7.4/§8/§11.6):
// 段角色文件状态浅覆盖、段级主角锚、节点进度与卡住引导、prompt 注入与 v1 降级
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyNodeProgress,
  applySegmentCharacter,
  buildTurnPromptParts,
  cardBrief,
  effectiveCard,
  nodeStallGuidance,
  NODE_STALL_TURNS
} from './game'
import type { SegmentDir } from './novel-v2'
import type { CharacterCard, CharacterDynamicState, GameState } from './novel'

const baseCard: CharacterCard = {
  name: '何清玲',
  role: '配角',
  identity: '学生',
  personality: ['认真'],
  background: '班主任信任的学习委员'
}

const npcCard: CharacterCard = { name: '小美', role: '配角', identity: '同学', personality: [] }
const oldProtagonist: CharacterCard = { name: '林凡', role: '主角', identity: '原著主角', personality: [] }

const segDir: SegmentDir = {
  canon: {
    index: 2,
    title: '恋爱期',
    cast: ['何清玲', '小美', '林凡'],
    主角: ['何清玲'],
    beat: '两人关系升温',
    节点: [
      { n: 0, 事件: '图书馆偶遇并约定一起复习' },
      { n: 1, 事件: '雨夜共撑一把伞回家,关系暧昧化' },
      { n: 2, 事件: '告白,确立恋爱关系' }
    ],
    text: '「借过。」'
  },
  characters: {
    何清玲: {
      姓名: '何清玲',
      剧情: '主动约林凡去图书馆,暗中观察他的反应',
      状态: { 身份: '学生兼女朋友', 性格: '认真、害羞', 处境: '恋爱初期' }
    },
    小美: {
      姓名: '小美',
      状态: { 身份: '情敌', 伤势: '无' }
    }
  }
}

function stateWith(over: Partial<GameState>): GameState {
  return { health: '良好', mood: '平静', ...over }
}

test('applySegmentCharacter:保留键按值容忍覆盖,未知键并入 profile', () => {
  const c = applySegmentCharacter(baseCard, segDir.characters['何清玲'])
  assert.equal(c.identity, '学生兼女朋友')
  // 性格给的是字符串 → 拆为数组(值容忍)
  assert.deepEqual(c.personality, ['认真', '害羞'])
  // 未识别键(处境)→ profile,不丢
  assert.equal((c.profile as Record<string, unknown>)['处境'], '恋爱初期')
  // 未覆盖字段继承基础卡
  assert.equal(c.background, '班主任信任的学习委员')
})

test('effectiveCard:叠加顺序 基础卡 → 段状态 → 运行时动态', () => {
  const c = effectiveCard(
    baseCard,
    2,
    { patch: { identity: '未婚妻' } },
    segDir.characters['何清玲']
  )
  assert.equal(c.identity, '未婚妻')
  assert.equal((c.profile as Record<string, unknown>)['处境'], '恋爱初期')
})

test('applyNodeProgress:无节点清进度;换段重置;推进与停滞计数', () => {
  // 无节点:清理遗留进度
  const cleared = applyNodeProgress(stateWith({ nodeProgress: { beat: 0, lastNode: 1, stallTurns: 3 } }), 1, 0, 0)
  assert.equal(cleared.nodeProgress, undefined)

  // 换段:重置(报告无效)
  const reset = applyNodeProgress(stateWith({ nodeProgress: { beat: 0, lastNode: 2, stallTurns: 0 } }), 1, null, 3)
  assert.deepEqual(reset.nodeProgress, { beat: 1, lastNode: -1, stallTurns: 1 })

  // 同段推进:清停滞
  const advanced = applyNodeProgress(stateWith({ nodeProgress: { beat: 1, lastNode: 0, stallTurns: 4 } }), 1, 2, 3)
  assert.deepEqual(advanced.nodeProgress, { beat: 1, lastNode: 2, stallTurns: 0 })

  // 同段停滞:累计
  const stalled = applyNodeProgress(stateWith({ nodeProgress: { beat: 1, lastNode: 0, stallTurns: 1 } }), 1, null, 3)
  assert.equal(stalled.nodeProgress?.stallTurns, 2)

  // 越界回报视为无效 → 停滞
  const invalid = applyNodeProgress(stateWith({ nodeProgress: { beat: 1, lastNode: 0, stallTurns: 0 } }), 1, 99, 3)
  assert.equal(invalid.nodeProgress?.stallTurns, 1)
})

test('nodeStallGuidance:达阈值且进度<40% 才给引导,指向下一未触发节点', () => {
  const nodes = segDir.canon.节点
  // 未达阈值
  const notYet = stateWith({ nodeProgress: { beat: 2, lastNode: -1, stallTurns: NODE_STALL_TURNS - 1 } })
  assert.equal(nodeStallGuidance(notYet, nodes), null)
  // 达阈值但已达 2/3(≥40%)
  const tooFar = stateWith({ nodeProgress: { beat: 2, lastNode: 1, stallTurns: NODE_STALL_TURNS } })
  assert.equal(nodeStallGuidance(tooFar, nodes), null)
  // 达阈值且 0/3:指向节点 0
  const stuck = stateWith({ nodeProgress: { beat: 2, lastNode: -1, stallTurns: NODE_STALL_TURNS } })
  assert.match(nodeStallGuidance(stuck, nodes) ?? '', /^【推进剧情】图书馆偶遇/)
  // 无节点数据:不引导(v1 降级)
  assert.equal(nodeStallGuidance(stuck, undefined), null)
})

function parts(v2?: SegmentDir) {
  return buildTurnPromptParts({
    title: '资料室之行',
    playerName: '林凡',
    playerCard: oldProtagonist,
    cards: [oldProtagonist, baseCard, npcCard],
    state: stateWith({ nodeProgress: { beat: 2, lastNode: 0, stallTurns: 0 } }),
    history: [],
    choice: '去图书馆',
    stageIndex: 2,
    storyline: [
      { index: 2, startChar: 0, label: '恋爱期', summary: '两人关系升温', cast: ['何清玲', '小美', '林凡'] }
    ],
    v2Segment: v2
  })
}

test('prompt:v2 段注入里程碑(已达摘要+下一未触发)与角色分线', () => {
  const text = parts(segDir).map(p => p.content).join('\n')
  // 已达节点 0 进入「已发生」,节点 1 为下一引导锚,节点 2 不注入
  assert.match(text, /已发生/)
  assert.match(text, /图书馆偶遇并约定一起复习/)
  assert.match(text, /下一节点[\s\S]*雨夜共撑一把伞回家/)
  assert.doesNotMatch(text, /告白,确立恋爱关系/)
  // 角色分线(段角色文件「剧情」)
  assert.match(text, /本段各角色分线/)
  assert.match(text, /何清玲:主动约林凡去图书馆/)
  // 段状态覆盖进卡摘要
  assert.match(text, /学生兼女朋友/)
})

test('prompt:段级主角锚优先于 role===主角;玩家扮演段主角时不重贴', () => {
  // 玩家是林凡(role 主角)但段主角=何清玲 → NPC 锚贴何清玲
  const text = parts(segDir).map(p => p.content).join('\n')
  assert.match(text, /【NPC 对手戏角色[\s\S]*何清玲/)

  // 玩家扮演段主角本人 → 不再重贴锚
  const playerIsSegProtagonist = buildTurnPromptParts({
    title: '资料室之行',
    playerName: '何清玲',
    playerCard: baseCard,
    cards: [baseCard, oldProtagonist],
    state: stateWith({}),
    history: [],
    stageIndex: 2,
    v2Segment: segDir
  }).map(p => p.content).join('\n')
  assert.doesNotMatch(playerIsSegProtagonist, /【NPC 对手戏角色[\s\S]*何清玲/)
})

test('prompt:无 v2 段数据时降级(v1 行为不变)', () => {
  const text = parts(undefined).map(p => p.content).join('\n')
  assert.doesNotMatch(text, /剧情里程碑/)
  assert.doesNotMatch(text, /本段各角色分线/)
  // 主角锚回退 role==='主角'(玩家即主角 → 不重贴)
  assert.doesNotMatch(text, /【NPC 对手戏角色/)
  // 卡摘要仍是基础卡
  assert.match(text, /学生/)
})

test('人物卡列表字段被 LLM patch 写成字符串时不崩溃(effectiveCard 归一 + cardBrief 防御)', () => {
  // 旧存档 characterStates.patch 里 LLM 曾把 secrets 写成字符串:effectiveCard 应用补丁后必须归一
  const card: CharacterCard = { ...baseCard, secrets: ['讨厌数学'] }
  // 真实场景该数据来自 IndexedDB 反序列化(无类型约束),故与运行时同样绕过类型直接构造
  const dyn = { patch: { secrets: '她其实一直喜欢同桌' } } as unknown as CharacterDynamicState
  const eff = effectiveCard(card, null, dyn)
  assert.deepEqual(eff.secrets, ['她其实一直喜欢同桌'])
  // cardBrief 不再抛 (t.secrets ?? []).filter is not a function
  const brief = cardBrief(eff, dyn)
  assert.match(brief, /秘密:她其实一直喜欢同桌/)
  // 补丁把整个列表字段写成数值/布尔也容忍(归一为空数组,不崩)
  const eff2 = effectiveCard(card, null, { patch: { goals: 42 } } as unknown as CharacterDynamicState)
  assert.doesNotThrow(() => cardBrief(eff2))
  assert.deepEqual(eff2.goals, [])
})
