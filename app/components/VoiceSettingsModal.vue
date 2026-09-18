<script setup lang="ts">
// 配音设置弹窗:旁白音色/语速 + 逐角色音色(不选 = 该角色不单独配音,对白回退旁白音色)。
// 设置保存在本浏览器 IndexedDB(按作品 scope 一行),改动即时保存;试听走同一播放队列。
import { ttsPlayer } from '../utils/ttsPlayer'
import { loadVoiceConfig, saveVoiceConfig, type WorkVoiceConfig } from '../utils/ttsPrefs'
import { TTS_SPEED_DEFAULT, TTS_SPEED_MAX, TTS_SPEED_MIN, TTS_VOICES } from '#shared/tts'

interface CharacterRow {
  name: string
  role?: string | null
  identity?: string | null
}

const props = defineProps<{
  open: boolean
  /** 配音设置归属 scope:作品 id 或 `preset:${预置小说 id}` */
  scopeId: string
  /** 可配音的角色清单(预置小说等无人物卡场景可不传,只配旁白) */
  characters?: CharacterRow[]
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  /** 保存后回传最新配置(页面用它刷新朗读分段) */
  'saved': [config: WorkVoiceConfig]
}>()

const toast = useToast()

const config = ref<WorkVoiceConfig>({ narratorVoice: '', speed: TTS_SPEED_DEFAULT, autoSpeak: true, characters: {} })
const loaded = ref(false)
/** 防抖保存(滑条拖动时避免每步一行 IndexedDB 写) */
let saveTimer: ReturnType<typeof setTimeout> | undefined

watch(() => props.open, async (open) => {
  if (!open || !props.scopeId) return
  loaded.value = false
  config.value = await loadVoiceConfig(props.scopeId)
  // 缺失的角色的配置补默认空值,保证 v-model 可写
  for (const c of props.characters ?? []) {
    if (!config.value.characters[c.name]) config.value.characters[c.name] = ''
  }
  loaded.value = true
})

watch(config, () => {
  if (!loaded.value || !props.scopeId) return
  // 任意设置变更:正在进行的朗读立即停止(旧队列基于旧音色/语速,继续播已不符合新设置),
  // 并即时回传新配置(页面立刻停跟读链、后续分段改用新配置);IndexedDB 写入仍防抖
  if (ttsPlayer.state.value !== 'idle') ttsPlayer.stopTts()
  emit('saved', JSON.parse(JSON.stringify(config.value)) as WorkVoiceConfig)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void persist()
  }, 300)
}, { deep: true })

async function persist() {
  try {
    await saveVoiceConfig(props.scopeId, config.value)
  } catch (e) {
    toast.add({ title: '配音设置保存失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 朗读实时状态(播放器是全局单例:剧情跟读/消息朗读/听书/试听共用,只读展示 + 暂停/停止) ----
const playState = computed(() => ttsPlayer.state.value)
const playSource = computed(() => ttsPlayer.currentSource.value)
const playIndex = computed(() => ttsPlayer.currentIndex.value)
const playTotal = computed(() => ttsPlayer.totalSegments.value)
const playSegText = computed(() => playSource.value?.segments[playIndex.value]?.text?.trim().slice(0, 50) ?? '')
const playProgress = computed(() => (playTotal.value > 0 ? Math.round((playIndex.value / playTotal.value) * 100) : 0))
const playStateLabel = computed(() =>
  ({ loading: '合成中', playing: '朗读中', paused: '已暂停', error: '出错' } as Record<string, string>)[playState.value] ?? '')

/**
 * 「不配音」哨兵值:reka 的 SelectItem 禁止空字符串 value(挂载即抛错,
 * 会打崩弹窗渲染树导致无法关闭),USelect 里用哨兵表示「关闭/不配音」,
 * 存配置与业务判断时还原为空字符串(空串 = 不配音/关闭旁白)。
 */
const NO_VOICE = '__none__'

/** 音色下拉(角色行含「不单独配音」;旁白含「关闭旁白」) */
const charVoiceItems = [
  { label: '不单独配音', value: NO_VOICE },
  ...TTS_VOICES.map(v => ({ label: v.label, value: v.value }))
]
const narratorVoiceItems = [
  { label: '关闭旁白(不朗读)', value: NO_VOICE },
  ...TTS_VOICES.map(v => ({ label: v.label, value: v.value }))
]

/** 角色行的下拉回显值(空 → 哨兵) */
function charVoiceModel(name: string): string {
  return config.value.characters[name] || NO_VOICE
}

/** 角色行下拉写入(哨兵 → 空串 = 不单独配音) */
function setCharacterVoice(name: string, v: string) {
  config.value.characters[name] = v === NO_VOICE ? '' : v
}

/** 旁白下拉写入(哨兵 → 空串 = 关闭旁白) */
function setNarratorVoice(v: string) {
  config.value.narratorVoice = v === NO_VOICE ? '' : v
}

/** 试听旁白音色(旁白关闭时禁用) */
function previewNarrator() {
  if (!config.value.narratorVoice) return
  void ttsPlayer.playTtsSource({
    id: 'voice-preview-narrator',
    label: '旁白试听',
    segments: [{ text: '这里是旁白音色,剧情描述将由它为你朗读。', voice: config.value.narratorVoice }]
  }, { speed: config.value.speed }).catch((e: unknown) => toastTtsError(e))
}

/** 试听角色音色(未设置的行按钮禁用) */
function previewCharacter(c: CharacterRow) {
  const voice = config.value.characters[c.name]
  if (!voice) return
  const identity = c.identity?.trim()
  void ttsPlayer.playTtsSource({
    id: `voice-preview:${c.name}`,
    label: `${c.name} 试听`,
    segments: [{ text: `我是${c.name}${identity ? `,${identity}` : ''}。`, voice }]
  }, { speed: config.value.speed }).catch((e: unknown) => toastTtsError(e))
}

function toastTtsError(e: unknown) {
  toast.add({ title: '语音合成失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
}
</script>

<template>
  <UModal
    :open="open"
    :ui="{ content: 'sm:max-w-lg!' }"
    @update:open="$emit('update:open', $event)"
  >
    <template #title>
      配音设置
    </template>
    <template #body>
      <p class="mb-4 text-xs text-neutral-500">
        设置保存在本浏览器(IndexedDB),换设备需重新配置。旁白朗读剧情描述(可选「关闭旁白」,只朗读角色台词);为角色单独设置音色后,对白将按角色发音。
      </p>
      <!-- 朗读实时进度(全局播放器:剧情跟读/消息朗读/听书/试听),可暂停/继续/停止 -->
      <div
        v-if="playSource && playState !== 'idle'"
        class="mb-4 rounded-lg border border-primary-500/30 bg-primary-500/5 px-3 py-2.5"
      >
        <div class="flex items-center justify-between gap-2">
          <p class="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <UIcon
              name="i-lucide-volume-2"
              class="size-4 shrink-0"
              :class="playState === 'playing' ? 'text-primary-500' : 'text-neutral-400'"
            />
            <span class="shrink-0">{{ playStateLabel }}</span>
            <span class="min-w-0 truncate text-neutral-500">· {{ playSource.label }}</span>
          </p>
          <div class="flex shrink-0 items-center gap-1">
            <UButton
              :icon="playState === 'paused' ? 'i-lucide-play' : 'i-lucide-pause'"
              :label="playState === 'paused' ? '继续' : '暂停'"
              size="xs"
              color="neutral"
              variant="soft"
              :disabled="playState === 'error'"
              @click="playState === 'paused' ? ttsPlayer.resumeTts() : ttsPlayer.pauseTts()"
            />
            <UButton
              icon="i-lucide-square"
              label="停止"
              size="xs"
              color="error"
              variant="soft"
              @click="ttsPlayer.stopTts()"
            />
          </div>
        </div>
        <p
          class="mt-1.5 truncate text-xs text-neutral-500"
          :title="playSource.segments[playIndex]?.text"
        >
          第 {{ playIndex + 1 }}/{{ playTotal }} 段:{{ playSegText }}
        </p>
        <UProgress
          :model-value="playProgress"
          size="xs"
          class="mt-1.5"
        />
      </div>
      <div
        v-if="loaded"
        class="flex flex-col gap-4"
      >
        <!-- 旁白音色 -->
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-sm font-medium">旁白</span>
          <USelect
            :model-value="config.narratorVoice || NO_VOICE"
            :items="narratorVoiceItems"
            class="flex-1"
            size="sm"
            @update:model-value="setNarratorVoice"
          />
          <UButton
            label="试听"
            icon="i-lucide-volume-2"
            color="neutral"
            variant="soft"
            size="sm"
            title="播放一段示例,试听当前选择的旁白音色"
            :disabled="!config.narratorVoice"
            @click="previewNarrator"
          />
        </div>

        <!-- 语速 -->
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-sm font-medium">语速</span>
          <USlider
            v-model="config.speed"
            :min="TTS_SPEED_MIN"
            :max="TTS_SPEED_MAX"
            :step="0.05"
            class="flex-1"
          />
          <span class="w-12 shrink-0 text-right text-xs text-neutral-500">{{ config.speed.toFixed(2) }}x</span>
        </div>

        <!-- 打字机跟读 -->
        <div class="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <p class="text-sm font-medium">
              打字机跟读
            </p>
            <p class="text-xs text-neutral-500">
              新回合剧情打字机显示时同步朗读:段落一开始显示就开播,文字与朗读并行(旁白与角色各用其音色);关闭后仅手动点消息旁的朗读按钮播放
            </p>
          </div>
          <USwitch
            v-model="config.autoSpeak"
            class="shrink-0"
          />
        </div>

        <!-- 逐角色音色 -->
        <div
          v-if="characters?.length"
          class="flex flex-col gap-2"
        >
          <p class="text-sm font-medium">
            角色音色
          </p>
          <div
            v-for="c in characters"
            :key="c.name"
            class="flex items-center gap-2"
          >
            <span
              class="w-24 shrink-0 truncate text-sm"
              :title="c.name"
            >{{ c.name }}</span>
            <USelect
              :model-value="charVoiceModel(c.name)"
              :items="charVoiceItems"
              placeholder="不单独配音"
              class="flex-1"
              size="sm"
              @update:model-value="v => setCharacterVoice(c.name, String(v))"
            />
            <UButton
              label="试听"
              icon="i-lucide-volume-2"
              color="neutral"
              variant="soft"
              size="sm"
              :title="config.characters[c.name] ? '播放示例,试听该角色的音色' : '先为该角色选择音色后可试听'"
              :disabled="!config.characters[c.name]"
              @click="previewCharacter(c)"
            />
          </div>
        </div>
      </div>
      <div
        v-else
        class="flex items-center justify-center py-8 text-sm text-neutral-400"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="mr-2 size-4 animate-spin"
        />
        加载设置中…
      </div>
    </template>
  </UModal>
</template>
