<script setup lang="ts">
// /play/[id] — 选角页(本地作品):展示人物卡 → 选择身份 → 创建本地游戏会话 → 进入游戏
import { getWork, touchWork } from '../../utils/worldGen'
import { createLocalGame } from '../../utils/gameStore'
import { uuid } from '../../../shared/novel'
import type { GameState } from '../../../shared/novel'

useHead({ title: 'AI StoryBound · 选择身份' })

const route = useRoute()
const router = useRouter()
const workId = route.params.id as string

const work = ref<Awaited<ReturnType<typeof getWork>>>(null)
const loadError = ref<string | null>(null)
const creating = ref(false)

onMounted(async () => {
  work.value = await getWork(workId)
  if (!work.value) loadError.value = '本地未找到该作品'
  else void touchWork(workId)
})

const cards = computed(() => work.value?.overlay?.characters ?? [])

async function startAs(characterName: string) {
  if (creating.value) return
  creating.value = true
  try {
    const relationships: Record<string, number> = {}
    for (const c of cards.value) {
      if (c.name !== characterName) relationships[c.name] = 0
    }
    const state: GameState = { location: '', time: '', hp: 100, money: 100, relationships, quests: [], flags: {} }
    const gameId = uuid()
    await createLocalGame({ id: gameId, workId, playerName: characterName, characterName, state })
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
          {{ c.personality.slice(0, 4).join(' · ') }}
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
