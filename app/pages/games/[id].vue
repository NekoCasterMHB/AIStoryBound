<script setup lang="ts">
// 游戏页:剧情流(SSE 打字机)+ 3 个选项 + 自由输入 + 公开状态面板 + 每回合 token 消耗
import { saveGamePoint, listGamePoints, pruneGamePoints } from '../../utils/gameSaveStore'

useHead({ title: 'AI StoryBound · 游戏' })

interface GameState {
  location?: string
  time?: string
  hp?: number
  money?: number
  relationships?: Record<string, number>
  quests?: string[]
  flags?: Record<string, unknown>
}
interface Msg {
  id: string
  idx: number
  role: string
  speaker: string | null
  content: string
}
interface OptionItem {
  idx: number
  text: string
}
interface GameDetail {
  id: string
  player_character_name: string | null
  current_chapter: string | null
  status: string
  state: GameState
  messages: Msg[]
  optionsByMessage: Record<string, OptionItem[]>
  world?: { title?: string, genre?: string, summary?: string }
}

const route = useRoute()
const gameId = route.params.id as string

const { data: detail } = await useFetch<GameDetail>(`/api/games/${gameId}`, { watch: false })

const messages = ref<Msg[]>(detail.value?.messages ?? [])
const state = ref<GameState>(detail.value?.state ?? {})
const playerName = ref(detail.value?.player_character_name ?? '玩家')
const currentChapter = ref<string | null>(detail.value?.current_chapter ?? null)

const lastMsgId = detail.value?.messages?.at(-1)?.id ?? ''
const options = ref<OptionItem[]>(detail.value ? (detail.value.optionsByMessage?.[lastMsgId] ?? []) : [])

const streaming = ref(false)
const streamText = ref('')
const tokens = ref(0)
const speed = ref(0)
const turnUsage = ref<string | null>(null)
const error = ref<string | null>(null)
const input = ref('')
const chatRef = ref<HTMLElement | null>(null)

const started = computed(() => messages.value.length > 0 || streaming.value)

async function sendTurn(choice?: string) {
  if (streaming.value) return
  streaming.value = true
  error.value = null
  turnUsage.value = null
  tokens.value = 0
  speed.value = 0
  streamText.value = ''
  options.value = []
  // 玩家的行动立即上屏(后端同步入库,刷新后从历史恢复)
  if (choice) {
    messages.value.push({
      id: `local-${Date.now()}`,
      idx: messages.value.length,
      role: 'user',
      speaker: playerName.value,
      content: choice
    })
  }
  try {
    const res = await fetch(`/api/games/${gameId}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(choice ? { choice } : {})
    })
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '')
      throw new Error(t ? t.slice(0, 200) : `请求失败 (${res.status})`)
    }
    await readSseStream(res, (ev) => {
      switch (ev.name) {
        case 'delta':
          streamText.value += String(ev.payload.text ?? '')
          break
        case 'token':
          tokens.value = Number(ev.payload.tokens ?? 0)
          speed.value = Number(ev.payload.speed ?? 0)
          break
        case 'options':
          options.value = (ev.payload.list as OptionItem[]) ?? []
          state.value = (ev.payload.state as GameState) ?? state.value
          currentChapter.value = (ev.payload.current_chapter as string | null) ?? currentChapter.value
          break
        case 'usage':
          turnUsage.value = `本回合 ${Number(ev.payload.totalTokens ?? 0).toLocaleString()} tokens`
          break
        case 'error':
          throw new Error(String(ev.payload.message ?? '回合失败'))
      }
    })
    if (streamText.value.trim()) {
      messages.value.push({
        id: `local-${Date.now()}`,
        idx: messages.value.length,
        role: 'narrator',
        speaker: null,
        content: streamText.value
      })
      streamText.value = ''
      // 回合完成:自动存档点(覆盖同 key,记录最新状态)
      savePointNow()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
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

// ---- 本地存档点(IndexedDB):每次行动完成后自动快照,长按/右键行动气泡可回滚 ----
/** 以当前界面状态写入一个存档点(key=最后一条消息序号) */
function savePointNow() {
  const last = messages.value.at(-1)
  if (!last) return
  void saveGamePoint({
    key: `${gameId}:${last.idx}`,
    gameId,
    idx: last.idx,
    state: JSON.parse(JSON.stringify(state.value)),
    currentChapter: currentChapter.value,
    messages: JSON.parse(JSON.stringify(messages.value)),
    savedAt: new Date().toISOString()
  }).catch(e => console.warn('[saveGamePoint] failed:', e))
}

// 初始存档点:页面加载即记录当前状态,保证第一轮行动也有回滚目标
onMounted(() => {
  const last = messages.value.at(-1)
  void saveGamePoint({
    key: `${gameId}:${last?.idx ?? -1}`,
    gameId,
    idx: last?.idx ?? -1,
    state: JSON.parse(JSON.stringify(state.value)),
    currentChapter: currentChapter.value,
    messages: JSON.parse(JSON.stringify(messages.value)),
    savedAt: new Date().toISOString()
  }).catch(e => console.warn('[saveGamePoint] failed:', e))
})

interface RollbackMenuState { x: number, y: number, msgId: string }

const rollbackMenu = ref<RollbackMenuState | null>(null)
let longPressTimer: ReturnType<typeof setTimeout> | null = null

async function openRollbackMenu(e: MouseEvent | PointerEvent, msg: Msg) {
  if (streaming.value || msg.role !== 'user') return
  // 只有存在更早的存档点才提供回滚
  const points = await listGamePoints(gameId)
  if (!points.some(p => p.idx < msg.idx)) return
  rollbackMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - 240),
    y: Math.min(e.clientY, window.innerHeight - 96),
    msgId: msg.id
  }
}

function startLongPress(e: PointerEvent, msg: Msg) {
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

/** 回滚到该行动之前:本地恢复快照,并同步服务端截断历史与状态 */
async function rollbackAction() {
  const menu = rollbackMenu.value
  if (!menu || streaming.value) return
  const msg = messages.value.find(m => m.id === menu.msgId)
  rollbackMenu.value = null
  if (!msg || msg.role !== 'user') return

  const points = await listGamePoints(gameId)
  const target = points.find(p => p.idx < msg.idx)
  if (!target) return

  try {
    await $fetch(`/api/games/${gameId}/rollback`, {
      method: 'POST',
      body: { idx: target.idx, state: target.state, current_chapter: target.currentChapter }
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return
  }

  messages.value = JSON.parse(JSON.stringify(target.messages))
  state.value = JSON.parse(JSON.stringify(target.state))
  currentChapter.value = target.currentChapter
  streamText.value = ''
  options.value = []
  turnUsage.value = null
  error.value = null

  // 清理失效快照,并以恢复后的状态重建当前存档点
  await pruneGamePoints(gameId, msg.idx)
  savePointNow()
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
            {{ detail?.world?.title || '游戏' }}
          </h1>
          <p class="text-xs text-neutral-500">
            你是「{{ playerName }}」{{ currentChapter ? ` · ${currentChapter}` : '' }}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span
            v-if="streaming"
            class="text-xs text-neutral-400 tabular-nums"
          >
            ≈ {{ tokens }} tokens · {{ speed }}/s
          </span>
          <span
            v-else-if="turnUsage"
            class="text-xs text-neutral-400"
          >
            {{ turnUsage }}
          </span>
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
              >
                {{ k }} {{ v > 0 ? '+' : '' }}{{ v }}
              </span>
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
            故事尚未开始。以「{{ playerName }}」的身份进入《{{ detail?.world?.title || '' }}》，AI 将为你铺设开场。
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

          <!-- 正在生成(打字机) -->
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
            v-for="o in options"
            :key="o.idx"
            color="neutral"
            variant="soft"
            class="h-auto py-2.5 text-left leading-snug"
            @click="pickOption(o.text)"
          >
            <!-- label prop 默认 truncate 会截断文字,这里用插槽自定义换行展示 -->
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

      <!-- 回滚菜单(长按/右键行动气泡弹出,渲染到 body) -->
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
