<script setup lang="ts">
// 游戏页(浏览器驱动回合):本地游戏会话 + 本地作品(人物卡) → /api/ai/chat 中继
// 叙事流式(打字机)→ 选项结构化 → mergeState 本地应用 → 落 IndexedDB + 本地存档点
// 回滚完全本地(存盘点恢复);登录用户可一键同步云端(跨设备续玩)。
import { aiChat, aiChatJson, estimateTokens } from '../../utils/aiRelay'
import { buildTurnPrompt, mergeState, TURN_OPTIONS_SCHEMA } from '#shared/game'
import { uuid } from '#shared/novel'
import type { GameState, LocalGame, LocalWork, TurnStructured } from '#shared/novel'
import { getLocalGame, saveLocalGame, syncGameToCloud } from '../../utils/gameStore'
import { getWork, touchWork, addWorkTokens } from '../../utils/worldGen'
import { saveGamePoint, listGamePoints, pruneGamePoints } from '../../utils/gameSaveStore'

useHead({ title: 'AI SpankWorld · 游戏' })

const route = useRoute()
const gameId = route.params.id as string

const game = ref<LocalGame | null>(null)
const work = ref<LocalWork | null>(null)
const state = ref<GameState>({})
const messages = ref<LocalGame['messages']>([])
const currentChapter = ref<string | null>(null)
const options = ref<{ idx: number, text: string }[]>([])
const loadError = ref<string | null>(null)

onMounted(async () => {
  const g = await getLocalGame(gameId)
  if (!g) {
    loadError.value = '本地未找到该游戏会话(可能已在新设备上;请从首页云端恢复)'
    return
  }
  game.value = g
  work.value = g.workId ? await getWork(g.workId) : null
  if (g.workId) void touchWork(g.workId)
  state.value = g.state
  messages.value = g.messages
  currentChapter.value = g.currentChapter ?? null
  const last = g.messages.at(-1)
  options.value = last ? (g.optionsByMessage?.[last.id] ?? []) : []
  // 初始存档点:保证第一轮行动也有回滚目标
  await savePointNow()
})

const playerName = computed(() => game.value?.playerName ?? '玩家')
const cards = computed(() => work.value?.overlay?.characters ?? [])
const playerCard = computed(() => cards.value.find(c => c.name === game.value?.characterName))

const streaming = ref(false)
const streamText = ref('')
const liveTokens = ref(0)
const liveSpeed = ref(0)
let liveStartedAt = 0
const turnUsage = ref<string | null>(null)
const error = ref<string | null>(null)
const input = ref('')
const chatRef = ref<HTMLElement | null>(null)

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
}

async function sendTurn(choice?: string) {
  if (streaming.value || !game.value) return
  streaming.value = true
  error.value = null
  turnUsage.value = null
  streamText.value = ''
  options.value = []
  liveTokens.value = 0
  liveSpeed.value = 0
  liveStartedAt = Date.now()

  if (choice) {
    messages.value.push({ id: uuid(), idx: messages.value.length, role: 'user', speaker: playerName.value, content: choice })
  }
  persist()

  try {
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
      summaryText: game.value.summary?.text
    })
    const narr = await aiChat(prompt, { maxTokens: 2400, temperature: 0.9, thinking: false }, {
      onDelta: (d) => {
        streamText.value += d
        // 实时消耗估算(与生成页一致:字符 → token,含速度)
        const elapsed = Date.now() - liveStartedAt
        const tokens = estimateTokens(streamText.value.length)
        liveTokens.value = tokens
        liveSpeed.value = elapsed > 0 ? Math.round((tokens / elapsed) * 1000) : 0
      }
    })
    if (!narr.ok) throw new Error(narr.message)
    // 游玩消耗累计到作品计量(含失败重试已消耗的部分)
    void addWorkTokens(game.value.workId, narr.usage?.totalTokens ?? 0)

    const narratorText = streamText.value.trim()
    if (!narratorText) throw new Error('AI 未返回剧情内容,请重试')
    const narratorMsg = { id: uuid(), idx: messages.value.length, role: 'narrator', speaker: null, content: narratorText }
    messages.value.push(narratorMsg)
    streamText.value = ''

    // 2) 选项 + 状态变化(结构化)
    const optRes = await aiChatJson<TurnStructured>(
      [
        {
          role: 'system',
          content: `你是回合收尾器。基于玩家的行动与上文剧情,给出 3 个下一回合的行动选项,以及本轮对游戏状态的增量变化(相对当前值)。\n输出 JSON:\n${TURN_OPTIONS_SCHEMA}`
        },
        {
          role: 'user',
          content: `当前状态:${JSON.stringify(state.value)}\n上文剧情:\n${messages.value.slice(-8).map(m => m.content).join('\n')}`
        }
      ],
      { maxTokens: 1200, temperature: 0.5, thinking: false }
    )
    if (!optRes.ok) throw new Error(optRes.message)
    void addWorkTokens(game.value.workId, optRes.usage?.totalTokens ?? 0)
    const turn = optRes.data

    state.value = mergeState(state.value, turn.state_delta)
    if (turn.current_chapter) currentChapter.value = turn.current_chapter
    options.value = (turn.options ?? []).map((t, i) => ({ idx: i, text: String(t) }))
    if (!game.value.optionsByMessage) game.value.optionsByMessage = {}
    game.value.optionsByMessage[narratorMsg.id] = JSON.parse(JSON.stringify(options.value))

    const total = (narr.usage?.totalTokens ?? 0) + (optRes.usage?.totalTokens ?? 0)
    turnUsage.value = `本回合 ${total.toLocaleString()} tokens`
    persist()
    await savePointNow()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    // 叙事已上屏而收尾失败:保留剧情,下次重试只补选项
    streamText.value = ''
  } finally {
    streaming.value = false
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
let longPressTimer: ReturnType<typeof setTimeout> | null = null

function startLongPress(e: PointerEvent, msg: LocalGame['messages'][number]) {
  if (streaming.value || msg.role !== 'user') return
  longPressTimer = setTimeout(() => {
    void openRollbackMenu(e, msg)
  }, 550)
}

function cancelLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

async function openRollbackMenu(e: MouseEvent | PointerEvent, msg: LocalGame['messages'][number]) {
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
  state.value = JSON.parse(JSON.stringify(target.state))
  currentChapter.value = target.currentChapter
  streamText.value = ''
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
watch([messages, streamText], async () => {
  await nextTick()
  chatRef.value?.scrollTo({ top: chatRef.value.scrollHeight, behavior: 'smooth' })
})
</script>

<template>
  <div class="min-h-[92vh] flex flex-col px-4 py-6">
    <div class="mx-auto flex w-full max-w-4xl flex-1 flex-col space-y-4">
      <!-- 顶栏 -->
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
            label="同步"
            icon="i-lucide-cloud-upload"
            color="neutral"
            variant="outline"
            size="sm"
            :loading="syncing"
            @click="onSyncCloud"
          />
          <UButton
            label="返回"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="outline"
            size="sm"
            :to="'/'"
          />
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
      <div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
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
            HP
          </p>
          <p class="font-semibold tabular-nums">
            {{ state.hp ?? '—' }}
          </p>
        </div>
        <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          <p class="text-neutral-500">
            金钱
          </p>
          <p class="font-semibold tabular-nums">
            {{ state.money ?? '—' }}
          </p>
        </div>
        <div class="col-span-2 rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800 sm:col-span-1">
          <p class="text-neutral-500">
            关系
          </p>
          <p class="truncate tabular-nums">
            <template v-if="state.relationships && Object.keys(state.relationships).length">
              <span
                v-for="(v, k) in state.relationships"
                :key="k"
                class="mr-1.5"
              >{{ k }} {{ v > 0 ? '+' : '' }}{{ v }}</span>
            </template>
            <template v-else>
              —
            </template>
          </p>
        </div>
      </div>

      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        :title="error"
        :icon="'i-lucide-triangle-alert'"
      />

      <!-- 剧情流 -->
      <div
        ref="chatRef"
        class="flex-1 space-y-4 overflow-y-auto rounded-xl border border-neutral-200 p-4 dark:border-neutral-700"
        style="max-height: 52vh; min-height: 240px"
      >
        <div
          v-if="!started && !streaming"
          class="flex h-full flex-col items-center justify-center gap-3 text-center"
        >
          <UIcon
            name="i-lucide-sparkles"
            class="size-8 text-neutral-300"
          />
          <p class="text-sm text-neutral-500">
            故事尚未开始。以「{{ playerName }}」的身份进入《{{ work?.overlay?.title || '' }}》，AI 将为你铺设开场。
          </p>
          <UButton
            label="开始故事"
            color="primary"
            icon="i-lucide-play"
            @click="sendTurn()"
          />
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
              class="max-w-[85%] cursor-context-menu select-none rounded-2xl rounded-br-sm border border-primary-500/40 bg-primary-500/15 px-4 py-2.5"
              @contextmenu.prevent="openRollbackMenu($event, m)"
              @pointerdown="startLongPress($event, m)"
              @pointerup="cancelLongPress"
              @pointerleave="cancelLongPress"
              @pointercancel="cancelLongPress"
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
            v-if="streaming"
            class="text-sm"
          >
            <p class="whitespace-pre-line leading-relaxed text-neutral-700 dark:text-neutral-200">
              {{ streamText }}<span class="animate-pulse">▍</span>
            </p>
          </div>
        </template>
      </div>

      <!-- 选项 + 自由输入 -->
      <div class="space-y-2">
        <div
          v-if="options.length && !streaming"
          class="grid gap-2"
        >
          <UButton
            v-for="(o, i) in options"
            :key="o.idx"
            color="neutral"
            variant="soft"
            class="h-auto py-2.5 text-left leading-snug option-fade-in"
            :style="{ animationDelay: `${i * 120}ms` }"
            @click="pickOption(o.text)"
          >
            <span class="min-w-0 whitespace-pre-line">{{ o.text }}</span>
          </UButton>
        </div>

        <p class="text-xs text-neutral-500">
          长按或右键自己的行动气泡，可回滚到该行动之前重新选择。
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
      </div>

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
