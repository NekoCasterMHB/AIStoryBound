<script setup lang="ts">
// /play/[id] — 选角页(本地作品):展示人物卡 → 选择身份 → 创建本地游戏会话 → 进入游戏
import { getWork, touchWork } from '../../utils/worldGen'
import { createLocalGame } from '../../utils/gameStore'
import { isAdultModeEnabled, setAdultModeEnabled } from '../../utils/adultMode'
import { ensureDesires } from '#shared/game'
import { uuid } from '#shared/novel'
import type { GameState, LocalGame } from '#shared/novel'

useHead({ title: 'AI Word2World · 选择身份' })

const route = useRoute()
const router = useRouter()
const workId = route.params.id as string
const toast = useToast()

const work = ref<Awaited<ReturnType<typeof getWork>>>(null)
const loadError = ref<string | null>(null)
const creating = ref(false)

onMounted(async () => {
  work.value = await getWork(workId)
  if (!work.value) loadError.value = '本地未找到该作品'
  else void touchWork(workId)
})

const cards = computed(() => work.value?.overlay?.characters ?? [])

// ---- 开场方式:ai=AI 生成开场供选择(默认) chapter=从小说章节开始 custom=玩家输入背景故事 ----

type OpeningMode = 'ai' | 'chapter' | 'custom'
const openingMode = ref<OpeningMode>('ai')
const openingModes = [
  { label: 'AI 生成开场', value: 'ai', description: '进入游戏后生成多个开场设定供选择' },
  { label: '从小说章节开始', value: 'chapter', description: '从所选章节的情节展开' },
  { label: '输入背景故事', value: 'custom', description: '按你写的背景设定生成开场' }
] satisfies { label: string, value: OpeningMode, description: string }[]

const chapters = computed(() => work.value?.chapters ?? [])
const chapterIndex = ref(0)
const customScene = ref('')

function chapterLabel(i: number) {
  const ch = chapters.value[i]
  if (!ch) return ''
  return ch.title || (i === 0 ? '前言' : `第 ${i + 1} 部分`)
}

const selectedChapter = computed(() => chapters.value[chapterIndex.value] ?? null)

/** 按所选模式构造开局设定;返回 error 表示缺必填内容 */
function buildOpening(): { opening: LocalGame['opening'], currentChapter?: string | null, error?: string } {
  if (openingMode.value === 'chapter') {
    const ch = selectedChapter.value
    if (!ch) return { opening: undefined, error: '请选择起始章节' }
    const label = chapterLabel(chapterIndex.value)
    // 携带上一章(背景)与下一章(情节走向):中间章节注入,首章/末章按存在性省略
    const prev = chapterIndex.value > 0 ? chapters.value[chapterIndex.value - 1] : null
    const next = chapterIndex.value < chapters.value.length - 1 ? chapters.value[chapterIndex.value + 1] : null
    return {
      opening: {
        mode: 'chapter',
        chapterTitle: label,
        chapterIndex: chapterIndex.value,
        chapterText: ch.content,
        ...(prev ? { prevChapter: { title: chapterLabel(chapterIndex.value - 1), text: prev.content } } : {}),
        ...(next ? { nextChapter: { title: chapterLabel(chapterIndex.value + 1), text: next.content } } : {})
      },
      currentChapter: label
    }
  }
  if (openingMode.value === 'custom') {
    const scene = customScene.value.trim()
    if (!scene) return { opening: undefined, error: '请先输入背景故事' }
    return { opening: { mode: 'custom', scene } }
  }
  return { opening: { mode: 'ai' } }
}

/** 成人模式开关(本地偏好,默认关闭):开启后本场游玩的成人内容频率大幅上升 */
const adultOn = ref(isAdultModeEnabled())
watch(adultOn, v => setAdultModeEnabled(v))

async function startAs(characterName: string) {
  if (creating.value) return
  const { opening, currentChapter, error } = buildOpening()
  if (error) {
    toast.add({ title: error, color: 'error' })
    return
  }
  creating.value = true
  try {
    const relationships: Record<string, number> = {}
    for (const c of cards.value) {
      if (c.name !== characterName) relationships[c.name] = 0
    }
    const state: GameState = ensureDesires({ location: '', time: '', health: '良好', mood: '平静', relationships, quests: [], flags: {} }, cards.value)
    const gameId = uuid()
    await createLocalGame({ id: gameId, workId, playerName: characterName, characterName, state, opening, currentChapter })
    router.push(`/games/${gameId}`)
  } finally {
    creating.value = false
  }
}

function roleColor(role: string | undefined) {
  if (role === '主角') return 'primary'
  if (role === '反派') return 'error'
  return 'neutral'
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">
          {{ work?.title || '作品' }}
        </h1>
        <p class="text-sm text-neutral-500">
          {{ work?.overlay?.summary || '选择你要扮演的角色' }}
        </p>
      </div>
      <UButton
        label="返回"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="outline"
        size="sm"
        to="/"
      />
    </div>

    <UAlert
      v-if="loadError"
      color="error"
      variant="soft"
      :title="loadError"
    />

    <UAlert
      v-if="cards.length === 0 && !loadError"
      color="warning"
      variant="soft"
      title="该作品还没有人物卡"
      description="请先在首页重新生成世界。"
    />

    <UCard class="mb-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="font-semibold">
            成人模式
          </p>
          <p class="text-xs text-neutral-500">
            开启后,本场游玩中成人内容出现频率大幅上升,并明显偏向训诫、BDSM、打屁股、捆绑、强制等亚文化题材,按角色性欲强度与当前性欲值推进;可在个人中心随时调整
          </p>
        </div>
        <USwitch v-model="adultOn" />
      </div>
    </UCard>

    <UCard class="mb-4">
      <div class="flex flex-col gap-3">
        <div>
          <p class="font-semibold">
            开场方式
          </p>
          <p class="text-xs text-neutral-500">
            决定游戏从什么情节开始,可在开始前随时切换
          </p>
        </div>
        <URadioGroup
          v-model="openingMode"
          :items="openingModes"
          variant="card"
          size="sm"
        />
        <div
          v-if="openingMode === 'chapter'"
          class="flex flex-col gap-2"
        >
          <p
            v-if="chapters.length === 0"
            class="text-xs text-amber-600 dark:text-amber-400"
          >
            该作品没有章节正文,无法从章节开始
          </p>
          <template v-else>
            <USelect
              v-model="chapterIndex"
              :items="chapters.map((_, i) => ({ label: chapterLabel(i), value: i }))"
              value-key="value"
              label-key="label"
            />
            <p
              v-if="selectedChapter"
              class="whitespace-pre-line text-xs text-neutral-500"
            >
              {{ selectedChapter.content.slice(0, 300) }}<template v-if="selectedChapter.content.length > 300">…</template>
            </p>
            <p
              v-if="selectedChapter"
              class="text-[11px] text-neutral-400"
            >
              共 {{ selectedChapter.content.length }} 字,将以完整正文注入开场;中间章节会连带注入上一章背景与下一章走向,从本章开头开始演绎
            </p>
          </template>
        </div>
        <UTextarea
          v-if="openingMode === 'custom'"
          v-model="customScene"
          autoresize
          :rows="3"
          placeholder="写一段背景设定,AI 将据此生成开场剧情,例如:我是落魄剑客,在雨夜酒馆里遇到了一个神秘女子…"
        />
        <p
          v-if="openingMode === 'ai'"
          class="text-xs text-neutral-500"
        >
          进入游戏后,AI 会先生成 3~4 个开场设定供你选择(默认选中第一个,可改选)
        </p>
      </div>
    </UCard>

    <div
      v-if="cards.length"
      class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <UCard
        v-for="c in cards"
        :key="c.name"
        class="flex h-full cursor-pointer flex-col transition hover:border-primary-400"
        :ui="{ body: 'flex flex-1 flex-col' }"
        @click="startAs(c.name)"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-base font-semibold">
              {{ c.name }}
            </p>
            <p class="text-xs text-neutral-500">
              {{ c.identity || '未知身份' }}
            </p>
          </div>
          <UBadge
            :color="roleColor(c.role)"
            variant="soft"
          >
            {{ c.role || '配角' }}
          </UBadge>
        </div>
        <p
          v-if="c.personality?.length"
          class="mt-3 text-xs text-neutral-400"
        >
          {{ c.personality.join(' · ') }}
        </p>
        <p
          v-if="c.background"
          class="mt-2 line-clamp-3 text-sm text-neutral-600 dark:text-neutral-300"
        >
          {{ c.background }}
        </p>
        <div class="mt-auto flex items-center justify-between pt-3 text-xs text-neutral-400">
          <span>{{ c.relationships?.length ? `关系网 ${c.relationships.length} 条` : '' }}</span>
          <span>{{ c.first_appearance || '' }}</span>
        </div>
        <UButton
          block
          class="mt-4"
          color="primary"
          variant="soft"
          :loading="creating"
          @click.stop="startAs(c.name)"
        >
          扮演{{ c.name }}
        </UButton>
      </UCard>
    </div>
  </div>
</template>
