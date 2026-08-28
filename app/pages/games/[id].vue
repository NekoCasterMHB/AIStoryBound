<script setup lang="ts">
// 游戏页(浏览器驱动回合):本地游戏会话 + 本地作品(人物卡) → /api/ai/chat 中继
// 叙事流式(打字机)→ 选项结构化 → mergeState 本地应用 → 落 IndexedDB + 本地存档点
// 回滚完全本地(存盘点恢复);登录用户可一键同步云端(跨设备续玩)。
import { aiChat, aiChatJson } from '../../utils/aiRelay'
import { estimateTextTokens } from '#shared/token-estimate'
import { isAdultModeEnabled, setAdultModeEnabled } from '../../utils/adultMode'
import { loadScenePrefs, saveScenePrefs } from '../../utils/scenePrefs'
import { loadNarrTemp, saveNarrTemp, NARR_TEMP_MIN, NARR_TEMP_MAX, NARR_TEMP_STEP } from '../../utils/narrPrefs'
import { loadEnabledAiSkillObjects, listInstalledSkills, loadEnabledAiSkills, saveEnabledAiSkills } from '../../utils/aiSkills'
import { buildTurnPrompt, cardBrief, ensureDesires, mergeState, narratorDeviceSpec, turnOptionsSchema, REINJECT_CHAPTER_EVERY, REINJECT_WINDOW_CHARS } from '#shared/game'
import { uuid } from '#shared/novel'
import type { GameState, LocalGame, LocalWork, TurnStructured } from '#shared/novel'
import { getLocalGame, saveLocalGame, syncGameToCloud } from '../../utils/gameStore'
import { isCloudSaveEnabled } from '../../utils/cloudSave'
import { getWork, touchWork, addWorkTokens } from '../../utils/worldGen'
import type { AiSkill } from '#shared/ai-skills'
import { saveGamePoint, listGamePoints, pruneGamePoints, capGamePoints } from '../../utils/gameSaveStore'
import { downloadGameAsTxt } from '../../utils/exportStory'
import { downloadGameAsZip } from '../../utils/shareZip'
import { toyController } from '../../toy/api'
import { loadToySettings } from '../../toy/store'
import { loadAllPluginSpecs } from '../../toy/runtime/adapter-loader'
import { isAdapterEnabled, DEFAULT_TOY_SETTINGS } from '#shared/toy'
import type { ToySettings } from '#shared/toy'
import { describePlugin } from '#shared/plugin'
import { loadNarrSpeed, saveNarrSpeed, narrSpeedTierOf, NARR_SPEED_TIERS } from '../../utils/narrSpeed'
import { loadNarrLength, saveNarrLength, NARR_LENGTH_MIN, NARR_LENGTH_MAX, NARR_LENGTH_STEP } from '../../utils/narrLength'
import { createNarrParser } from '../../utils/narrStream'
import { createTypewriter } from '../../utils/typewriter'
import type { NarrParser } from '../../utils/narrStream'
import type { Typewriter } from '../../utils/typewriter'

useHead({ title: 'AI Word2World · 游戏' })
// 沉浸式游戏布局:无导航栏/页脚,整页禁滚动(占满视口),内部区域自行滚动
definePageMeta({ layout: 'game' })

const route = useRoute()
const gameId = route.params.id as string

const game = ref<LocalGame | null>(null)
const work = ref<LocalWork | null>(null)
const state = ref<GameState>({})
const messages = ref<LocalGame['messages']>([])
const currentChapter = ref<string | null>(null)
const options = ref<{ idx: number, text: string }[]>([])
const loadError = ref<string | null>(null)

/** 「本地存档上云」开关(个人中心设置,默认关闭):关闭时不上传任何云端数据 */
const cloudSaveEnabled = ref(isCloudSaveEnabled())
/** 「成人模式」开关(游戏内设置弹窗/个人中心,默认关闭):开启后成人内容频率大幅上升 */
const adultMode = ref(isAdultModeEnabled())
watch(adultMode, v => setAdultModeEnabled(v))
/** 用户偏好/避免场景(游戏内设置弹窗/个人中心,优先级低于系统规则),回合开始时读入 */
const scenePrefs = reactive(loadScenePrefs())
/** 叙事温度(游戏内设置弹窗/个人中心滑动条,默认 1.2):回合正文/选项/状态结算共用的随机性档位 */
const narrTemp = ref(loadNarrTemp())
watch(narrTemp, v => saveNarrTemp(v))
/** 每回合生成字数(游戏内设置弹窗/个人中心滑动条,默认 400 字):回合正文目标篇幅,并据此缩放叙事 maxTokens */
const narrLength = ref(loadNarrLength())
watch(narrLength, v => saveNarrLength(v))
/** 叙事速度(游戏内设置弹窗/个人中心,IndexedDB 持久化):回合正文流式速率档位,新回合生效 */
const narrSpeed = ref(60)
const narrSpeedLoaded = ref(false)
void loadNarrSpeed().then((cps) => {
  narrSpeed.value = cps
  narrSpeedLoaded.value = true
})
function pickNarrSpeed(cps: number): void {
  narrSpeed.value = cps
  if (narrSpeedLoaded.value) void saveNarrSpeed(cps)
}

// ---- 游戏内设置弹窗(个人中心「模型设置」成人模式往下的游玩偏好项,改动即时保存/新回合生效) ----

const settingsOpen = ref(false)
const sceneMsg = ref<{ kind: 'ok' | 'err', text: string } | null>(null)
function submitScenePrefs() {
  saveScenePrefs({ prefer: scenePrefs.prefer, avoid: scenePrefs.avoid })
  sceneMsg.value = { kind: 'ok', text: '已保存,新回合生效' }
}

// ---- 章节回注定位(每 N 回合把当前章剩余情节窗口 + 下一章开头窗口重新注入提示词) ----

/** 回注定位:当前章索引 + 章内字符偏移(AI 报告进入新章时重置偏移) */
const plotPos = ref({ idx: 0, offset: 0 })

/** 解析回注定位的章节索引:优先开局 chapterIndex,再按标题匹配作品章节(旧存档回退),缺省 0 */
function resolveChapterIndex(title: string | null | undefined): number {
  const chapters = work.value?.chapters ?? []
  const op = game.value?.opening
  if (op?.mode === 'chapter' && typeof op.chapterIndex === 'number' && chapters[op.chapterIndex]) {
    return op.chapterIndex
  }
  if (title) {
    const idx = chapters.findIndex(c => c.title === title || (c.title && (c.title.startsWith(title) || title.startsWith(c.title))))
    if (idx >= 0) return idx
  }
  return 0
}

/** 每回合推进回注定位:AI 报告的新章节在作品中匹配到 → 换章并重置偏移;仍在原章 → 偏移累加本回合实际旁白字数 */
function advancePlotPos(reportedChapter: string | null | undefined, chars: number): void {
  const chapters = work.value?.chapters ?? []
  if (chapters.length === 0) return
  const cur = plotPos.value
  const curTitle = chapters[cur.idx]?.title ?? ''
  if (reportedChapter && curTitle && curTitle !== reportedChapter) {
    // 尝试从当前章向后匹配报告章节(精确/前缀/包含)
    let matched = -1
    for (let i = cur.idx; i < chapters.length; i++) {
      const t = chapters[i]?.title ?? ''
      if (t === reportedChapter || (t && (t.startsWith(reportedChapter) || reportedChapter.startsWith(t)))) {
        matched = i
        break
      }
    }
    if (matched >= 0) {
      plotPos.value = { idx: matched, offset: 0 }
      return
    }
  }
  // 仍在原章:偏移按实际旁白字数累加(不超章节长度,防止窗口越界)
  const maxOffset = Math.max(0, (chapters[cur.idx]?.content?.length ?? 0) - 1)
  plotPos.value = { idx: cur.idx, offset: Math.min(maxOffset, cur.offset + chars) }
}

/** 构建回注窗口:当前章从定位起 1500 字(剩余情节窗口)+ 下一章开头 1500 字(接下来的走向) */
function buildReinjectWindow(): { currentTitle?: string, window: string, nextWindow?: string } | undefined {
  const chapters = work.value?.chapters ?? []
  if (chapters.length === 0) return undefined
  const ch = chapters[plotPos.value.idx]
  if (!ch) return undefined
  const text = ch.content ?? ''
  const start = Math.max(0, Math.min(plotPos.value.offset, text.length))
  const window = text.slice(start, start + REINJECT_WINDOW_CHARS)
  const next = chapters[plotPos.value.idx + 1]
  const nextWindow = next ? (next.content ?? '').slice(0, REINJECT_WINDOW_CHARS) : ''
  if (!window && !nextWindow) return undefined
  return { currentTitle: ch.title || undefined, window, nextWindow }
}
/** AI Skill 玩法库(个人中心逐项开关 + 链接导入):本轮成人互动可用的玩法菜单(含详细设定)
 *  异步加载(IndexedDB),sendTurn 前必须 await 完成,否则首回合技能不会注入 prompt */
const activeSkills = ref<Awaited<ReturnType<typeof loadEnabledAiSkillObjects>>>([])
const skillsLoadPromise = loadEnabledAiSkillObjects()
  .then((list) => {
    activeSkills.value = list
  })
  .catch(() => {
    // 本地注册表异常时保持空列表,不阻塞开局
  })

/** 玩具控制:设备设置(硬限制/总开关,IndexedDB);AI 开关打开且有已启用插件时,叙事提示词注入内联指令语法 */
const toySettings = ref<ToySettings | null>(null)
void loadToySettings().then((s) => {
  toySettings.value = s
})

onMounted(async () => {
  const g = await getLocalGame(gameId)
  if (!g) {
    loadError.value = '本地未找到该游戏会话(可能已在新设备上;请到书架「云端游戏」恢复)'
    return
  }
  game.value = g
  work.value = g.workId ? await getWork(g.workId) : null
  if (g.workId) void touchWork(g.workId)
  state.value = ensureDesires(g.state, cards.value)
  messages.value = g.messages
  currentChapter.value = g.currentChapter ?? null
  plotPos.value = { idx: resolveChapterIndex(g.currentChapter), offset: 0 }
  const last = g.messages.at(-1)
  options.value = last ? (g.optionsByMessage?.[last.id] ?? []) : []
  // 初始存档点:保证第一轮行动也有回滚目标
  await savePointNow()
  // 开启上云时,进入游戏先把最新进度推到云端
  if (cloudSaveEnabled.value) void syncGameToCloud(game.value)
})

const playerName = computed(() => game.value?.playerName ?? '玩家')
const cards = computed(() => work.value?.overlay?.characters ?? [])
const playerCard = computed(() => cards.value.find(c => c.name === game.value?.characterName))

const streaming = ref(false)
/** 叙事流式已完成、选项(结构化)生成中:此阶段显示选项骨架屏 */
const awaitingOptions = ref(false)
/** 打字机已显示文本(限速 + 标点停顿;指令不可见) */
const streamDisplay = ref('')
const liveTokens = ref(0)
const liveSpeed = ref(0)
let liveStartedAt = 0
const turnUsage = ref<string | null>(null)
const error = ref<string | null>(null)
const input = ref('')
const chatRef = ref<HTMLElement | null>(null)
const toast = useToast()

// ---- 流式打字机(每回合一个 parser + typewriter;点击流式文本立即显示全文) ----
let narrParser: NarrParser | null = null
let typewriter: Typewriter | null = null

/** 点击流式文本 → 立即显示全文(剩余设备指令顺序执行,停顿跳过,自动会话收尾) */
function flushStream() {
  typewriter?.flush()
}

onUnmounted(() => {
  typewriter?.dispose()
  typewriter = null
})

// ---- 技能管理(模态框:启用/禁用已安装技能,切换后立即影响后续回合注入) ----

const skillModalOpen = ref(false)
const installedSkills = ref<AiSkill[]>([])
const enabledSkillKeys = ref<string[]>([])
const skillsLoading = ref(false)

async function openSkillManager() {
  skillModalOpen.value = true
  skillsLoading.value = true
  try {
    const [list, keys] = await Promise.all([
      listInstalledSkills(),
      Promise.resolve(loadEnabledAiSkills())
    ])
    installedSkills.value = list
    enabledSkillKeys.value = keys
  } finally {
    skillsLoading.value = false
  }
}

function toggleSkill(key: string, on: boolean) {
  enabledSkillKeys.value = on
    ? [...new Set([...enabledSkillKeys.value, key])]
    : enabledSkillKeys.value.filter(k => k !== key)
  saveEnabledAiSkills(enabledSkillKeys.value)
  // 立即刷新本页技能注入源,下一回合 prompt 即生效
  void loadEnabledAiSkillObjects().then((list) => {
    activeSkills.value = list
  })
}

// ---- 状态面板:关系/性欲查看与手动调节(草稿 → 确认弹窗 → 应用) ----

type StatKind = 'relations' | 'desires'
const statModalOpen = ref(false)
const statKind = ref<StatKind>('relations')
/** 草稿:角色名 → 新值(打开时从当前状态复制;应用前不改动真实状态) */
const statDraft = ref<Record<string, number>>({})
const confirmOpen = ref(false)

/** 面板展示用摘要:前两位角色 + 总数 */
function statBrief(source: Record<string, number> | undefined): string {
  const entries = Object.entries(source ?? {})
  if (entries.length === 0) return '—'
  const shown = entries.slice(0, 2).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(' · ')
  return entries.length > 2 ? `${shown} 等${entries.length}人` : shown
}

const relationBrief = computed(() => statBrief(state.value.relationships))
const desireBrief = computed(() => statBrief(state.value.desires))

const statRoles = computed(() => cards.value.filter(c => c.name !== playerName.value).map(c => c.name))
const statTitle = computed(() => (statKind.value === 'relations' ? '关系状态' : '性欲状态'))
const statFieldName = computed(() => (statKind.value === 'relations' ? '好感度' : '性欲值'))

function openStatModal(kind: StatKind) {
  statKind.value = kind
  const source = kind === 'relations' ? state.value.relationships : state.value.desires
  const draft: Record<string, number> = {}
  for (const name of statRoles.value) draft[name] = source?.[name] ?? 0
  statDraft.value = draft
  statModalOpen.value = true
}

interface StatChange { name: string, old: number, next: number }
const pendingChanges = ref<StatChange[]>([])
const singleChange = computed(() => pendingChanges.value[0])

/** 点「确定变更」:对比草稿与当前状态,有改动则弹确认 */
function submitDraft() {
  const source = statKind.value === 'relations' ? (state.value.relationships ?? {}) : (state.value.desires ?? {})
  pendingChanges.value = Object.entries(statDraft.value)
    .map(([name, next]) => ({ name, old: source[name] ?? 0, next }))
    .filter(c => c.old !== c.next)
  if (pendingChanges.value.length === 0) {
    statModalOpen.value = false
    return
  }
  confirmOpen.value = true
}

/** 确认应用:写入状态并落盘 */
function confirmChanges() {
  const next = statKind.value === 'relations' ? { ...(state.value.relationships ?? {}) } : { ...(state.value.desires ?? {}) }
  const clamp: [number, number] = statKind.value === 'relations' ? [-100, 100] : [0, 100]
  for (const c of pendingChanges.value) next[c.name] = Math.max(clamp[0], Math.min(clamp[1], Math.round(c.next)))
  if (statKind.value === 'relations') state.value.relationships = next
  else state.value.desires = next
  confirmOpen.value = false
  statModalOpen.value = false
  persist()
}

// ---- AI 开场生成(opening.mode = 'ai' 且未选定场景时,点「开始故事」先进入开场选择) ----

interface OpeningCard { title: string, scene: string }
const openingCards = ref<OpeningCard[] | null>(null)
const openingPick = ref(0)
const generatingOpening = ref(false)
const openingError = ref<string | null>(null)

/** 生成 3~4 个开场设定,默认选中第一个,玩家可改选后开始 */
async function generateOpenings() {
  if (generatingOpening.value) return
  generatingOpening.value = true
  openingError.value = null
  openingCards.value = null
  try {
    const card = playerCard.value
    const brief = card ? `${card.name}(${card.identity ?? '未知身份'}):${(card.personality ?? []).slice(0, 3).join('/')} ${card.background ?? ''}` : playerName.value
    const res = await aiChatJson<{ openings: OpeningCard[] }>(
      [
        {
          role: 'system',
          content: `你是故事开场设计师。基于作品设定与玩家角色,构思 3~4 个互不相同的开场剧情点,每个包含标题与场景描述(须写清玩家所处场景与第一个矛盾,80~150 字,第二人称叙述)。输出 JSON:\n{"openings":[{"title":"开场标题","scene":"场景描述"}]}`
        },
        {
          role: 'user',
          content: `作品《${work.value?.overlay?.title || '未命名小说'}》,题材:${work.value?.overlay?.genre ?? '未知'}\n故事背景:${work.value?.overlay?.summary ?? '无'}\n玩家扮演:${brief}\n当前状态:${JSON.stringify(state.value)}`
        }
      ],
      { maxTokens: 800, temperature: 1.0, thinking: false }
    )
    if (!res.ok) throw new Error(res.message)
    void addWorkTokens(game.value?.workId ?? '', res.usage?.totalTokens ?? 0)
    const list = (res.data.openings ?? []).slice(0, 4)
    if (list.length === 0) throw new Error('AI 未返回开场设定,请重试')
    openingCards.value = list
    openingPick.value = 0
  } catch (e) {
    openingError.value = e instanceof Error ? e.message : String(e)
  } finally {
    generatingOpening.value = false
  }
}

/** 以选中的开场开始:写入会话后进入正常回合 */
function confirmOpening() {
  const card = openingCards.value?.[openingPick.value]
  if (!card || !game.value) return
  if (!game.value.opening) game.value.opening = { mode: 'ai' }
  game.value.opening.scene = `${card.title}。${card.scene}`
  persist()
  openingCards.value = null
  sendTurn()
}

/** 开局按起始情节初始化各角色性欲值(覆盖公式播种值;失败静默保留原值,不阻塞开局)。
 *  仅首回合、带开局设定且未初始化过时调用,标记写入 opening 防止回滚后重复扣费。 */
async function seedDesiresByOpening(): Promise<void> {
  const op = game.value?.opening
  if (!op || op.desiresSeeded) return
  const scene = op.mode === 'chapter' ? op.chapterText : op.scene
  if (!scene?.trim()) return
  const briefs = cards.value.map(cardBrief)
  if (briefs.length === 0) return
  const res = await aiChatJson<{ desires: Record<string, number> }>(
    [
      {
        role: 'system',
        content: '你是角色状态初始化器。根据起始情节与人物卡,判断此刻各角色的性欲状态(0-100:0=毫无兴味,50=中性,100=极度亢奋)。结合人物卡的性欲强度档位(高=易被挑起,低=波动小)与情节氛围(亲密/惩罚/日常等)赋值,数值必须贴合当前情节,不要平均化。输出 JSON:\n{"desires":{"角色名":整数}}'
      },
      {
        role: 'user',
        content: `起始情节:\n${scene.trim().slice(0, 1500)}\n\n人物卡:\n${briefs.join('\n')}\n\n当前公式播种值(仅参考,请按情节覆盖):${JSON.stringify(state.value.desires ?? {})}`
      }
    ],
    { maxTokens: 400, temperature: 0.4, thinking: false }
  )
  if (!res.ok) return
  void addWorkTokens(game.value?.workId ?? '', res.usage?.totalTokens ?? 0)
  const desires = { ...(state.value.desires ?? {}) }
  let changed = false
  for (const c of cards.value) {
    const v = res.data.desires?.[c.name]
    if (typeof v === 'number' && Number.isFinite(v)) {
      desires[c.name] = Math.max(0, Math.min(100, Math.round(v)))
      changed = true
    }
  }
  if (!changed) return
  state.value.desires = desires
  op.desiresSeeded = true
  persist()
}

/** 空态「开始故事」:AI 开场模式未选定时先生成开场供选择 */
function onStartStory() {
  const op = game.value?.opening
  if (op?.mode === 'ai' && !op.scene) {
    void generateOpenings()
    return
  }
  sendTurn()
}

const started = computed(() => messages.value.length > 0 || streaming.value)

function persist() {
  if (!game.value) return
  game.value.state = JSON.parse(JSON.stringify(state.value))
  game.value.messages = JSON.parse(JSON.stringify(messages.value))
  game.value.currentChapter = currentChapter.value
  game.value.syncStatus = game.value.syncStatus === 'synced' ? 'dirty' : game.value.syncStatus
  void saveLocalGame(game.value)
}

async function savePointNow() {
  const last = messages.value.at(-1)
  await saveGamePoint({
    key: `${gameId}:${last?.idx ?? -1}`,
    gameId,
    idx: last?.idx ?? -1,
    state: JSON.parse(JSON.stringify(state.value)),
    currentChapter: currentChapter.value,
    messages: JSON.parse(JSON.stringify(messages.value)),
    savedAt: new Date().toISOString()
  }).catch(() => {})
  await capGamePoints(gameId)
}

async function sendTurn(choice?: string) {
  if (streaming.value || !game.value) return
  streaming.value = true
  awaitingOptions.value = false
  error.value = null
  turnUsage.value = null
  streamDisplay.value = ''
  options.value = []
  liveTokens.value = 0
  liveSpeed.value = 0
  liveStartedAt = Date.now()

  // 本回合打字机:叙事速度(游戏内设置弹窗/个人中心)→ 限速/停顿;设备指令到句执行,自动会话回调
  typewriter?.dispose()
  narrParser = createNarrParser()
  const speedTier = narrSpeedTierOf(narrSpeed.value)
  typewriter = createTypewriter({
    cps: narrSpeed.value,
    pauseScale: speedTier.pauseScale,
    onDisplay: (t) => {
      streamDisplay.value = t
    },
    onExecute: (cmd) => {
      // 指令分发:dev 单次事件 / wave 调教(AI 门槛+上限钳制)/ stop 停止调教
      if (cmd.kind === 'wave') {
        return toyController.startWaveForAI(cmd.function, cmd.pattern, cmd.duration, toySettings.value ?? DEFAULT_TOY_SETTINGS).then((r) => {
          if (!r.ok) {
            toast.add({ title: '调教指令被拒绝', description: r.reason, color: 'error' })
          }
          return r.ok
        })
      }
      if (cmd.kind === 'stop') {
        toyController.stopWave(cmd.function)
        return true
      }
      return toyController.execute({
        function: cmd.function,
        intensity: cmd.intensity,
        ...(cmd.mode != null ? { mode: cmd.mode } : {}),
        ...(cmd.duration != null && cmd.duration > 0 ? { duration: cmd.duration } : {})
      }, { source: 'ai', settings: toySettings.value ?? DEFAULT_TOY_SETTINGS }).then((r) => {
        if (!r.ok) {
          toast.add({ title: '设备指令被拒绝', description: r.reason, color: 'error' })
        }
        return r.ok
      })
    },
    onAutoStart: () => toyController.beginAutoSession(),
    onAutoEnd: () => toyController.endAutoSession()
  })

  if (choice) {
    messages.value.push({ id: uuid(), idx: messages.value.length, role: 'user', speaker: playerName.value, content: choice })
  }
  persist()

  try {
    // 技能注册表就绪后再组装 prompt(首回合玩家可能立即点「开始故事」)
    await skillsLoadPromise
    // 首回合且带开局设定:先按起始情节初始化各角色性欲值,再进入叙事
    if (messages.value.length === 0) {
      await seedDesiresByOpening()
    }
    // 设备联动提示词:AI 开关打开且有已启用插件时,叙事提示词注入内联指令语法与能力清单
    // (逐条标注清单声明的强度范围;指令数量由 AI 按情节判断,不设上限)
    const settingsNow = toySettings.value
    const enabledBriefs = settingsNow
      ? (await loadAllPluginSpecs())
          .filter(s => isAdapterEnabled(settingsNow, s.descriptor.id))
          .map(s => describePlugin(s, toyController.state.adapterId === s.descriptor.id))
      : []
    const deviceEnabled = !!settingsNow?.aiEnabled && enabledBriefs.length > 0
    const deviceSpec = deviceEnabled ? narratorDeviceSpec(enabledBriefs) : ''
    // 章节回注:每 REINJECT_CHAPTER_EVERY 回合,按当前定位取当前章剩余情节窗口 + 下一章开头窗口
    const turnIndex = messages.value.filter(m => m.role === 'narrator').length
    const reinjectPlot = turnIndex > 0 && turnIndex % REINJECT_CHAPTER_EVERY === 0 && game.value.opening?.mode === 'chapter'
      ? buildReinjectWindow()
      : undefined
    // 1) 叙事流式(中继 SSE)
    const prompt = buildTurnPrompt({
      title: work.value?.overlay?.title || '未命名小说',
      genre: work.value?.overlay?.genre,
      summary: work.value?.overlay?.summary,
      playerName: playerName.value,
      playerCard: playerCard.value,
      cards: cards.value,
      state: state.value,
      history: messages.value,
      choice,
      summaryText: game.value.summary?.text,
      adultMode: adultMode.value,
      activeSkills: activeSkills.value,
      preferScenes: scenePrefs.prefer ?? undefined,
      avoidScenes: scenePrefs.avoid ?? undefined,
      opening: game.value.opening,
      deviceSpec,
      narrLength: narrLength.value,
      entities: work.value?.entities,
      conflicts: work.value?.conflicts,
      reinjectPlot
    })
    const narr = await aiChat(prompt, { maxTokens: Math.min(2400, Math.max(800, Math.round(narrLength.value * 2))), temperature: narrTemp.value, thinking: false }, {
      onDelta: (d) => {
        // 解析器增量识别 [[dev:...]] / [[pause:...]],打字机按序消费(文本限速 + 停顿;指令到句执行)
        const tokens = narrParser?.feed(d) ?? []
        typewriter?.push(tokens)
        // 实时消耗估算(与生成页一致:CJK 感知字符 → token,含速度;用 fullText 不因显示延迟失真)
        const elapsed = Date.now() - liveStartedAt
        const tokensOut = typewriter ? estimateTextTokens(typewriter.fullText) : 0
        liveTokens.value = tokensOut
        liveSpeed.value = elapsed > 0 ? Math.round((tokensOut / elapsed) * 1000) : 0
      }
    })
    if (!narr.ok) throw new Error(narr.message)
    // 游玩消耗累计到作品计量(含失败重试已消耗的部分)
    void addWorkTokens(game.value.workId, narr.usage?.totalTokens ?? 0)

    // 流结束:解析器收尾(丢弃未闭合指令)→ 推送剩余 token,打字机按原速继续播完
    // (不再立即上屏全部;点击流式正文仍可跳过,播完后再生成选项)
    const tail = narrParser?.finish() ?? []
    typewriter?.push(tail)
    await typewriter?.done()
    const narratorText = (typewriter?.fullText ?? streamDisplay.value).trim()
    if (!narratorText) throw new Error('AI 未返回剧情内容,请重试')
    const narratorMsg = { id: uuid(), idx: messages.value.length, role: 'narrator', speaker: null, content: narratorText }
    messages.value.push(narratorMsg)
    // 叙事已上屏,进入选项生成阶段:显示骨架屏等待
    awaitingOptions.value = true

    // 2) 选项 + 状态变化 + 剧情摘要(结构化);设备控制已走叙事流内联指令,收尾器不含设备字段
    const optRes = await aiChatJson<TurnStructured>(
      [
        {
          role: 'system',
          content: `你是回合收尾器。基于玩家的行动与上文剧情,给出 3 个下一回合的行动选项、本轮对游戏状态的增量变化(相对当前值),以及整局剧情摘要。\n输出 JSON:\n${turnOptionsSchema()}`
        },
        {
          role: 'user',
          content: `当前剧情摘要:${game.value.summary?.text ?? '无'}\n当前状态:${JSON.stringify(state.value)}\n上文剧情:\n${messages.value.slice(-12).map(m => m.content).join('\n')}`
        }
      ],
      { maxTokens: 1200, temperature: narrTemp.value, thinking: false }
    )
    if (!optRes.ok) throw new Error(optRes.message)
    void addWorkTokens(game.value.workId, optRes.usage?.totalTokens ?? 0)
    const turn = optRes.data

    state.value = mergeState(state.value, turn.state_delta, cards.value)
    if (turn.current_chapter) currentChapter.value = turn.current_chapter
    if (turn.summary) game.value.summary = { idx: narratorMsg.idx, text: turn.summary }
    options.value = (turn.options ?? []).map((t, i) => ({ idx: i, text: String(t) }))
    if (!game.value.optionsByMessage) game.value.optionsByMessage = {}
    game.value.optionsByMessage[narratorMsg.id] = JSON.parse(JSON.stringify(options.value))
    // 推进章节回注定位:AI 报告进入新章则换章重置,否则按本回合实际旁白字数累加偏移
    advancePlotPos(turn.current_chapter, narratorText.length)

    const total = (narr.usage?.totalTokens ?? 0) + (optRes.usage?.totalTokens ?? 0)
    turnUsage.value = `本回合 ${total.toLocaleString()} tokens`
    persist()
    await savePointNow()
    // 开启「本地存档上云」时,每回合结束自动同步(未登录或失败静默跳过)
    if (cloudSaveEnabled.value) void syncGameToCloud(game.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    // 叙事已上屏而收尾失败:保留剧情,下次重试只补选项
    typewriter?.flush()
  } finally {
    // 回合结束:清理打字机,自动会话兜底收尾(解锁手动面板)
    typewriter?.dispose()
    typewriter = null
    narrParser = null
    toyController.endAutoSession()
    streaming.value = false
    awaitingOptions.value = false
  }
}

function pickOption(text: string) {
  input.value = ''
  void sendTurn(text)
}

function sendInput() {
  const v = input.value.trim()
  if (!v) return
  input.value = ''
  void sendTurn(v)
}

// ---- 回滚(纯本地:存盘点恢复) ----

interface RollbackMenuState { x: number, y: number, msgId: string }

const rollbackMenu = ref<RollbackMenuState | null>(null)

async function openRollbackMenu(e: MouseEvent, msg: LocalGame['messages'][number]) {
  if (streaming.value || msg.role !== 'user') return
  const points = await listGamePoints(gameId)
  if (!points.some(p => p.idx < msg.idx)) return
  rollbackMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - 240),
    y: Math.min(e.clientY, window.innerHeight - 96),
    msgId: msg.id
  }
}

async function rollbackAction() {
  const menu = rollbackMenu.value
  if (!menu || streaming.value) return
  const msg = messages.value.find(m => m.id === menu.msgId)
  rollbackMenu.value = null
  if (!msg || msg.role !== 'user') return

  const points = await listGamePoints(gameId)
  const target = points.find(p => p.idx < msg.idx)
  if (!target) return

  messages.value = JSON.parse(JSON.stringify(target.messages))
  state.value = ensureDesires(JSON.parse(JSON.stringify(target.state)), cards.value)
  currentChapter.value = target.currentChapter
  // 回滚后按恢复的章节重置回注定位(偏移归零,从该章开头重新定位,不跳过情节)
  plotPos.value = { idx: resolveChapterIndex(target.currentChapter), offset: 0 }
  streamDisplay.value = ''
  typewriter?.dispose()
  typewriter = null
  narrParser = null
  options.value = []
  turnUsage.value = null
  error.value = null
  if (game.value) {
    if (!game.value.optionsByMessage) game.value.optionsByMessage = {}
    // 重建选项表,丢弃已回滚掉的消息对应的选项(避免动态 delete)
    const kept: Record<string, { idx: number, text: string }[]> = {}
    for (const [k, v] of Object.entries(game.value.optionsByMessage)) {
      if (messages.value.some(m => m.id === k)) kept[k] = v
    }
    game.value.optionsByMessage = kept
  }
  persist()
  await pruneGamePoints(gameId, msg.idx)
  await savePointNow()
  if (cloudSaveEnabled.value && game.value) void syncGameToCloud(game.value)
}

// ---- 分享(菜单:剧情 TXT / 全部 ZIP) ----

/** 分享包内含完整作品 + 会话,与书架「导入 ZIP 分享包」配套 */
function onExportZip() {
  if (streaming.value || !game.value) return
  downloadGameAsZip({
    title: work.value?.overlay?.title,
    playerName: playerName.value,
    chapter: currentChapter.value,
    work: work.value,
    game: game.value,
    messages: messages.value
  })
}

const shareMenuItems = [
  { label: '分享剧情 TXT', icon: 'i-lucide-file-text', onSelect: onExportTxt },
  { label: '分享全部 ZIP', icon: 'i-lucide-file-archive', onSelect: onExportZip }
]

function onExportTxt() {
  if (streaming.value) return
  const ok = downloadGameAsTxt({
    title: work.value?.overlay?.title,
    playerName: playerName.value,
    chapter: currentChapter.value,
    messages: messages.value
  })
  if (!ok) toast.add({ title: '还没有剧情可导出', description: '先开始故事,产生一段旁白后再导出', color: 'warning' })
}

// ---- 云端同步 ----

const syncing = ref(false)
const syncMsg = ref<string | null>(null)

async function onSyncCloud() {
  if (!game.value || syncing.value) return
  syncing.value = true
  syncMsg.value = null
  try {
    const ok = await syncGameToCloud(game.value)
    syncMsg.value = ok ? '已同步到云端' : '同步失败(未登录或网络错误)'
  } finally {
    syncing.value = false
  }
}

// 新内容自动滚到底部
watch([messages, streamDisplay], async () => {
  await nextTick()
  chatRef.value?.scrollTo({ top: chatRef.value.scrollHeight, behavior: 'smooth' })
})
</script>

<template>
  <div class="flex h-full flex-col px-4">
    <div class="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden">
      <!-- 顶栏(固定置顶):标题行 + 地点/时间等状态排 -->
      <div class="shrink-0 space-y-4 pt-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <h1 class="truncate text-xl font-semibold">
            {{ work?.overlay?.title || '故事' }}
          </h1>
          <p class="text-xs text-neutral-500">
            你是「{{ playerName }}」{{ currentChapter ? ` · ${currentChapter}` : '' }}
            <span
              v-if="game?.syncStatus === 'dirty'"
              class="ml-1 text-amber-500"
            >· 未同步</span>
            <span
              v-else-if="game?.syncStatus === 'synced'"
              class="ml-1 text-emerald-500"
            >· 已同步</span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span
            v-if="streaming && liveTokens > 0"
            class="text-xs text-neutral-400 tabular-nums"
          >≈ {{ liveTokens }} tokens · {{ liveSpeed }}/s</span>
          <span
            v-else-if="turnUsage"
            class="text-xs text-neutral-400"
          >{{ turnUsage }}</span>
          <UButton
            v-if="cloudSaveEnabled"
            label="同步"
            icon="i-lucide-cloud-upload"
            color="neutral"
            variant="outline"
            size="sm"
            :loading="syncing"
            @click="onSyncCloud"
          />
          <UDropdownMenu
            :items="shareMenuItems"
            :disabled="!started || streaming"
          >
            <UButton
              label="分享"
              icon="i-lucide-share-2"
              color="neutral"
              variant="outline"
              size="sm"
            />
          </UDropdownMenu>
          <UButton
            label="技能"
            icon="i-lucide-wand-2"
            color="neutral"
            variant="outline"
            size="sm"
            @click="openSkillManager"
          />
          <UButton
            label="设置"
            icon="i-lucide-settings"
            color="neutral"
            variant="outline"
            size="sm"
            @click="settingsOpen = true"
          />
          <UButton
            label="返回"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="outline"
            size="sm"
            :to="'/'"
          />
          <!-- 外部设备连接入口:顶栏图标 + 弹出菜单 -->
          <ToyControlStrip />
        </div>
      </div>

      <UAlert
        v-if="loadError"
        color="error"
        variant="soft"
        :title="loadError"
      />
      <UAlert
        v-if="syncMsg"
        color="success"
        variant="soft"
        :title="syncMsg"
      />

      <!-- 公开状态面板 -->
      <div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-6">
        <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          <p class="text-neutral-500">
            地点
          </p>
          <p class="truncate font-semibold">
            {{ state.location || '未知' }}
          </p>
        </div>
        <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          <p class="text-neutral-500">
            时间
          </p>
          <p class="truncate font-semibold">
            {{ state.time || '—' }}
          </p>
        </div>
        <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          <p class="text-neutral-500">
            身体状况
          </p>
          <p class="truncate font-semibold">
            {{ state.health || '—' }}
          </p>
        </div>
        <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          <p class="text-neutral-500">
            心情
          </p>
          <p class="truncate font-semibold">
            {{ state.mood || '—' }}
          </p>
        </div>
        <div
          class="cursor-pointer rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800"
          title="点击查看详情并调节"
          @click="openStatModal('relations')"
        >
          <p class="text-neutral-500">
            关系
          </p>
          <p class="truncate tabular-nums">
            {{ relationBrief }}
          </p>
        </div>
        <div
          class="cursor-pointer rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800"
          title="点击查看详情并调节"
          @click="openStatModal('desires')"
        >
          <p class="text-neutral-500">
            性欲
          </p>
          <p class="truncate tabular-nums">
            {{ desireBrief }}
          </p>
        </div>
      </div>
      </div>

      <!-- 关系/性欲:查看详情与手动调节 -->
      <UModal
        :open="statModalOpen"
        :ui="{ content: 'sm:max-w-md!' }"
        @update:open="statModalOpen = $event"
      >
        <template #title>
          {{ statTitle }}
        </template>
        <template #body>
          <div class="flex flex-col gap-4">
            <p class="text-xs text-neutral-500">
              拖动滑块调节数值,保存时需要二次确认;修改可能影响剧情走向
            </p>
            <div
              v-for="name in statRoles"
              :key="name"
              class="flex flex-col gap-1"
            >
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium">{{ name }}</span>
                <span class="tabular-nums text-neutral-500">{{ statDraft[name] ?? 0 }}</span>
              </div>
              <USlider
                v-model="statDraft[name]"
                :min="statKind === 'relations' ? -100 : 0"
                :max="100"
                :step="1"
                size="sm"
                tooltip
              />
            </div>
            <p
              v-if="statRoles.length === 0"
              class="text-xs text-neutral-400"
            >
              暂无角色数据
            </p>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <UButton
              label="取消"
              color="neutral"
              variant="outline"
              size="sm"
              @click="statModalOpen = false"
            />
            <UButton
              label="确定变更"
              color="primary"
              size="sm"
              @click="submitDraft"
            />
          </div>
        </template>
      </UModal>

      <UModal
        :open="confirmOpen"
        @update:open="confirmOpen = $event"
      >
        <template #title>
          确认修改
        </template>
        <template #body>
          <div class="flex flex-col gap-2 text-sm">
            <template v-if="pendingChanges.length === 1 && singleChange">
              <p>
                确认修改「{{ singleChange.name }}」的{{ statFieldName }}为 {{ singleChange.next }} 么?
              </p>
            </template>
            <template v-else>
              <p>
                确认修改以下数值么?
              </p>
              <ul class="space-y-1 text-xs text-neutral-500">
                <li
                  v-for="c in pendingChanges"
                  :key="c.name"
                >· {{ c.name }} {{ statFieldName }}: {{ c.old }} → {{ c.next }}</li>
              </ul>
            </template>
            <p class="text-xs text-amber-600 dark:text-amber-400">
              可能影响剧情走向
            </p>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <UButton
              label="取消变更"
              color="neutral"
              variant="outline"
              size="sm"
              @click="confirmOpen = false"
            />
            <UButton
              label="确定变更"
              color="primary"
              size="sm"
              @click="confirmChanges"
            />
          </div>
        </template>
      </UModal>

      <!-- 技能管理:启用/禁用已安装技能(切换后下一回合生效) -->
      <UModal
        :open="skillModalOpen"
        :ui="{ content: 'sm:max-w-lg!' }"
        @update:open="skillModalOpen = $event"
      >
        <template #title>
          <span class="flex items-center gap-2">
            技能管理
            <UBadge
              color="primary"
              variant="soft"
              size="sm"
            >{{ enabledSkillKeys.filter(k => installedSkills.some(s => s.key === k)).length }} 个已启用</UBadge>
          </span>
        </template>
        <template #body>
          <div class="flex flex-col gap-3">
            <p class="text-xs text-neutral-500">
              开启的技能会按玩法指引在剧情中展开(注入叙事提示词),切换后下一回合生效
            </p>
            <div
              v-if="skillsLoading"
              class="flex items-center justify-center gap-2 py-6 text-sm text-neutral-400"
            >
              <UIcon
                name="i-lucide-loader-circle"
                class="size-4 animate-spin"
              />
              加载中…
            </div>
            <p
              v-else-if="installedSkills.length === 0"
              class="py-6 text-center text-sm text-neutral-400"
            >
              还没有已安装的技能,请到「个人中心 → 技能商城」下载
            </p>
            <div
              v-else
              class="flex flex-col gap-2"
            >
              <div
                v-for="s in installedSkills"
                :key="s.key"
                class="flex items-start justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2.5 dark:border-neutral-700"
              >
                <div class="min-w-0">
                  <p class="text-sm font-medium">
                    {{ s.name }}
                  </p>
                  <p class="line-clamp-2 text-xs text-neutral-500">
                    {{ s.desc }}
                  </p>
                </div>
                <USwitch
                  :model-value="enabledSkillKeys.includes(s.key)"
                  size="sm"
                  class="shrink-0"
                  @update:model-value="v => toggleSkill(s.key, !!v)"
                />
              </div>
            </div>
          </div>
        </template>
      </UModal>

      <!-- 游戏内设置:个人中心「模型设置」成人模式往下的游玩偏好项,改动即时保存/新回合生效 -->
      <UModal
        :open="settingsOpen"
        :ui="{ content: 'sm:max-w-lg!' }"
        @update:open="settingsOpen = $event"
      >
        <template #title>
          游戏设置
        </template>
        <template #body>
          <div class="flex max-h-[65vh] flex-col gap-5 overflow-y-auto pr-1">
            <!-- 成人模式 -->
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p class="text-sm font-semibold">
                  成人模式
                </p>
                <p class="text-xs text-neutral-500">
                  开启后,游玩时成人内容出现频率大幅上升,并明显偏向训诫、BDSM、打屁股、捆绑、强制等亚文化题材;默认关闭,对所有游戏生效
                </p>
              </div>
              <USwitch v-model="adultMode" />
            </div>

            <!-- 叙事温度 -->
            <div class="flex flex-col gap-2">
              <p class="text-sm font-semibold">
                叙事温度
              </p>
              <p class="text-xs text-neutral-500">
                控制回合正文的随机性与文风多样性,滑动即时保存,新回合生效;选项生成与状态结算同样随此温度变化
              </p>
              <div class="flex items-center gap-4">
                <USlider
                  v-model="narrTemp"
                  :min="NARR_TEMP_MIN"
                  :max="NARR_TEMP_MAX"
                  :step="NARR_TEMP_STEP"
                  class="flex-1"
                />
                <span class="w-12 shrink-0 text-right font-mono text-sm text-neutral-700 dark:text-neutral-300">{{ narrTemp.toFixed(1) }}</span>
              </div>
            </div>

            <!-- 叙事速度 -->
            <div class="flex flex-col gap-2">
              <p class="text-sm font-semibold">
                叙事速度
              </p>
              <p class="text-xs text-neutral-500">
                控制回合正文流式显示的快慢与停顿节奏(打字机效果),新回合生效;点击流式正文可立即显示全文
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  v-for="t in NARR_SPEED_TIERS"
                  :key="t.cps"
                  size="sm"
                  variant="soft"
                  :color="narrSpeed === t.cps ? 'primary' : 'neutral'"
                  @click="pickNarrSpeed(t.cps)"
                >
                  {{ t.label }}
                </UButton>
                <span class="text-xs text-neutral-500">
                  当前 {{ narrSpeed }} 字符/秒
                </span>
              </div>
            </div>

            <!-- 每回合生成字数 -->
            <div class="flex flex-col gap-2">
              <p class="text-sm font-semibold">
                每回合生成字数
              </p>
              <p class="text-xs text-neutral-500">
                控制每回合 AI 生成的剧情正文篇幅,滑动即时保存,新回合生效;选项与状态结算不受影响
              </p>
              <div class="flex items-center gap-4">
                <USlider
                  v-model="narrLength"
                  :min="NARR_LENGTH_MIN"
                  :max="NARR_LENGTH_MAX"
                  :step="NARR_LENGTH_STEP"
                  class="flex-1"
                />
                <span class="w-16 shrink-0 text-right font-mono text-sm text-neutral-700 dark:text-neutral-300">{{ narrLength }} 字</span>
              </div>
            </div>

            <!-- 游玩偏好场景 -->
            <div class="flex flex-col gap-2">
              <p class="text-sm font-semibold">
                游玩偏好场景
              </p>
              <p class="text-xs text-neutral-500">
                自定义叙事提示词:「偏好场景」适度增加相关内容,「避免场景」尽量不出现;优先级低于系统规则,保存后新回合生效
              </p>
              <UTextarea
                v-model="scenePrefs.prefer"
                :rows="2"
                placeholder="偏好场景,可填写多个,用逗号分隔,留空不生效"
                class="w-full"
              />
              <UTextarea
                v-model="scenePrefs.avoid"
                :rows="2"
                placeholder="避免出现的场景,可填写多个,用逗号分隔,留空不生效"
                class="w-full"
              />
              <div class="flex items-center gap-3">
                <UButton
                  color="primary"
                  size="sm"
                  icon="i-lucide-save"
                  @click="submitScenePrefs"
                >
                  保存偏好
                </UButton>
                <p
                  v-if="sceneMsg"
                  class="text-xs"
                  :class="sceneMsg.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'"
                >
                  {{ sceneMsg.text }}
                </p>
              </div>
            </div>
          </div>
        </template>
      </UModal>

      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        :title="error"
        :icon="'i-lucide-triangle-alert'"
      />

      <!-- 剧情流:充满剩余空间,内部滚动 -->
      <div
        ref="chatRef"
        class="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-neutral-200 p-4 dark:border-neutral-700"
      >
        <div
          v-if="!started && !streaming"
          class="flex h-full flex-col items-center justify-center gap-3 text-center"
        >
          <!-- AI 开场模式且未选定场景:先生成开场供选择 -->
          <template v-if="game?.opening?.mode === 'ai' && !game.opening.scene">
            <template v-if="generatingOpening">
              <UIcon
                name="i-lucide-loader-circle"
                class="size-8 animate-spin text-neutral-300"
              />
              <p class="text-sm text-neutral-500">
                AI 正在构思开场设定…
              </p>
            </template>
            <template v-else-if="openingError">
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-8 text-red-300"
              />
              <p class="text-sm text-red-500">
                {{ openingError }}
              </p>
              <UButton
                label="重新生成"
                color="primary"
                icon="i-lucide-refresh-cw"
                @click="generateOpenings()"
              />
            </template>
            <template v-else-if="openingCards?.length">
              <p class="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                选择一个开场设定,开始故事
              </p>
              <div class="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                <button
                  v-for="(c, i) in openingCards"
                  :key="i"
                  class="rounded-xl border p-3 text-left transition"
                  :class="i === openingPick
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-neutral-200 hover:border-primary-400 dark:border-neutral-700'"
                  @click="openingPick = i"
                >
                  <p
                    class="flex items-center gap-1.5 text-sm font-semibold"
                    :class="i === openingPick ? 'text-primary-600 dark:text-primary-400' : ''"
                  >
                    <UIcon
                      v-if="i === openingPick"
                      name="i-lucide-check-circle-2"
                      class="size-4"
                    />
                    {{ c.title }}
                  </p>
                  <p class="mt-1 whitespace-pre-line text-xs text-neutral-500">
                    {{ c.scene }}
                  </p>
                </button>
              </div>
              <UButton
                label="以选中的开场开始"
                color="primary"
                icon="i-lucide-play"
                @click="confirmOpening()"
              />
            </template>
            <template v-else>
              <UIcon
                name="i-lucide-sparkles"
                class="size-8 text-neutral-300"
              />
              <p class="text-sm text-neutral-500">
                故事尚未开始。以「{{ playerName }}」的身份进入《{{ work?.overlay?.title || '' }}》，AI 将为你生成开场设定。
              </p>
              <UButton
                label="开始故事"
                color="primary"
                icon="i-lucide-play"
                @click="onStartStory()"
              />
            </template>
          </template>
          <!-- 章节开场/背景故事开场:直接开始 -->
          <template v-else>
            <UIcon
              name="i-lucide-sparkles"
              class="size-8 text-neutral-300"
            />
            <p class="text-sm text-neutral-500">
              故事尚未开始。以「{{ playerName }}」的身份进入《{{ work?.overlay?.title || '' }}》
              <template v-if="game?.opening?.mode === 'chapter'">，将从「{{ game.opening.chapterTitle || '所选章节' }}」开头的情节开始演绎。</template>
              <template v-else-if="game?.opening?.mode === 'custom'">，将按你提供的背景故事开场。</template>
              <template v-else>，AI 将为你铺设开场。</template>
            </p>
            <UButton
              label="开始故事"
              color="primary"
              icon="i-lucide-play"
              @click="sendTurn()"
            />
          </template>
        </div>

        <template v-else>
          <div
            v-for="m in messages"
            :key="m.id"
            class="text-sm"
            :class="m.role === 'user' ? 'flex justify-end' : ''"
          >
            <div
              v-if="m.role === 'user'"
              class="max-w-[85%] cursor-pointer select-none rounded-2xl rounded-br-sm border border-primary-500/40 bg-primary-500/15 px-4 py-2.5"
              @click="openRollbackMenu($event, m)"
            >
              <p class="flex items-center gap-1 text-xs font-semibold text-primary-500">
                <UIcon
                  name="i-lucide-user-round"
                  class="size-3.5"
                />
                {{ playerName }}的行动
              </p>
              <p class="mt-1 whitespace-pre-line font-medium text-neutral-800 dark:text-neutral-100">
                {{ m.content }}
              </p>
            </div>
            <p
              v-else
              class="whitespace-pre-line leading-relaxed text-neutral-700 dark:text-neutral-200"
            >
              {{ m.content }}
            </p>
          </div>

          <div
            v-if="streaming && !awaitingOptions"
            class="text-sm"
          >
            <p
              class="whitespace-pre-line leading-relaxed text-neutral-700 dark:text-neutral-200"
              title="点击立即显示全文"
              @click="flushStream"
            >
              {{ streamDisplay }}<span class="animate-pulse">▍</span>
            </p>
          </div>
        </template>
      </div>

      <!-- 底部固定:选项或「行动中」占位 + 自由输入 -->
      <footer class="shrink-0 space-y-2 pb-3 pt-3">
        <!-- 选项按钮 -->
        <div
          v-if="options.length && !streaming"
          class="grid gap-2"
        >
          <UButton
            v-for="(o, i) in options"
            :key="o.idx"
            color="neutral"
            variant="soft"
            class="h-auto py-2.5 leading-snug option-fade-in"
            :style="{ animationDelay: `${i * 120}ms` }"
            @click="pickOption(o.text)"
          >
            <span class="flex w-full items-center gap-2">
              <span class="shrink-0 font-semibold text-neutral-400">&gt;</span>
              <span class="min-w-0 flex-1 whitespace-pre-line text-left">{{ o.text }}</span>
              <UIcon
                name="i-lucide-arrow-right"
                class="size-4 shrink-0 text-neutral-400"
              />
            </span>
          </UButton>
        </div>

        <!-- 无选项时「行动中」占位(AI 生成中 / 等待行动) -->
        <div
          v-else
          class="flex h-11 items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 text-sm text-neutral-400 dark:border-neutral-700"
        >
          <UIcon
            :name="streaming ? 'i-lucide-loader-circle' : 'i-lucide-hourglass'"
            class="size-4"
            :class="{ 'animate-spin': streaming }"
          />
          行动中…
        </div>

        <p class="text-xs text-neutral-500">
          点击自己的行动气泡，可回滚到该行动之前重新选择。
        </p>

        <div class="flex gap-2">
          <UInput
            v-model="input"
            class="flex-1"
            :placeholder="started ? '自由输入你的行动…' : '开始故事后即可输入行动'"
            :disabled="!started || streaming"
            @keydown.enter="sendInput"
          />
          <UButton
            icon="i-lucide-send"
            color="primary"
            :loading="streaming"
            :disabled="!started || streaming || !input.trim()"
            @click="sendInput"
          >
            行动
          </UButton>
        </div>
      </footer>

      <!-- 回滚菜单 -->
      <Teleport to="body">
        <div
          v-if="rollbackMenu"
          class="fixed inset-0 z-40"
          @click="rollbackMenu = null"
          @contextmenu.prevent="rollbackMenu = null"
        />
        <div
          v-if="rollbackMenu"
          class="fixed z-50 w-56 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
          :style="{ left: `${rollbackMenu.x}px`, top: `${rollbackMenu.y}px` }"
        >
          <UButton
            label="回到这一步重新选择"
            icon="i-lucide-rotate-ccw"
            color="primary"
            variant="soft"
            block
            @click="rollbackAction"
          />
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
/* 选项逐个淡入:间隔 120ms 依次出现 */
.option-fade-in {
  opacity: 0;
  animation: option-fade-in 0.4s ease-out both;
}

@keyframes option-fade-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
