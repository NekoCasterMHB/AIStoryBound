<script setup lang="ts">
// 选角页:展示小说人物卡,点击选中 → 以该角色身份创建游戏会话
useHead({ title: 'AI StoryBound · 选择角色' })

interface CharacterCard {
  name: string
  role: string
  alias?: string | null
  gender?: string | null
  age?: string | null
  identity?: string | null
  appearance?: string | null
  personality?: string[]
  speech_style?: string[]
  background?: string | null
  abilities?: string[]
  goals?: string[]
  fears?: string[]
  secrets?: string[]
  relationships?: { name: string, type: string, value: number }[]
  first_appearance?: string | null
  dead?: boolean | null
  patience?: number | null
  softness?: number | null
}
interface WorldOverlay {
  title?: string
  genre?: string
  summary?: string
  characters?: CharacterCard[]
}
interface GameResult {
  id: string
  novel_id: string
  player_character_name: string
  mode: string
  status: string
  state?: { hp?: number, money?: number, location?: string, relationships?: Record<string, number> }
  world?: { title?: string, genre?: string, summary?: string }
}

const route = useRoute()
const novelId = route.params.id as string

const { data: novel } = await useFetch<Record<string, unknown>>(`/api/novels/${novelId}`, { watch: false })
const world = computed<WorldOverlay | null>(() => {
  const ws = novel.value?.world_state
  if (typeof ws === 'string' && ws) {
    try {
      return JSON.parse(ws) as WorldOverlay
    } catch {
      return null
    }
  }
  return null
})
const characters = computed(() => world.value?.characters ?? [])

const selected = ref<string | null>(null)
const creating = ref(false)
const error = ref<string | null>(null)
const created = ref<GameResult | null>(null)

function roleColor(role?: string) {
  if (role === '主角') return 'primary' as const
  if (role === '反派') return 'error' as const
  return 'neutral' as const
}

async function createGame() {
  if (!selected.value || creating.value) return
  creating.value = true
  error.value = null
  try {
    created.value = await $fetch<GameResult>('/api/games', {
      method: 'POST',
      body: { novelId, characterName: selected.value }
    })
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.statusMessage || e?.message || '创建会话失败'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="min-h-[92vh] px-4 py-8">
    <div class="mx-auto w-full max-w-4xl space-y-6">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold tracking-tight">
            {{ world?.title || '选择角色' }}
          </h1>
          <p class="text-sm text-neutral-500">
            {{ world?.genre || '未知题材' }} · 选择一个身份进入故事
          </p>
        </div>
        <UButton
          label="返回"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :to="'/'"
        />
      </div>

      <p
        v-if="world?.summary"
        class="text-sm text-neutral-600 dark:text-neutral-300"
      >
        {{ world.summary }}
      </p>

      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        :title="error"
        :icon="'i-lucide-triangle-alert'"
      />

      <!-- 角色选择(未建会话前) -->
      <div v-if="!created">
        <p class="mb-3 text-sm font-medium">
          选择你要扮演的角色（{{ characters.length }}）
        </p>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <button
            v-for="c in characters"
            :key="c.name"
            type="button"
            class="rounded-xl border-2 p-4 text-left transition-all"
            :class="selected === c.name
              ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
              : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600'"
            @click="selected = c.name"
          >
            <UCard
              :ui="{ root: 'shadow-none' }"
              class="gap-0 space-y-3 border-0 bg-transparent"
            >
              <div class="flex items-center gap-3">
                <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-500/10 text-sm font-semibold text-primary-500">
                  {{ (c.name || '?').slice(0, 1) }}
                </div>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="font-semibold">{{ c.name }}</span>
                    <UBadge
                      :color="roleColor(c.role)"
                      variant="subtle"
                      :label="c.role"
                    />
                  </div>
                  <p class="truncate text-xs text-neutral-500">
                    {{ [c.identity, c.gender, c.age].filter(Boolean).join(' · ') || '未知身份' }}
                  </p>
                  <p
                    v-if="c.patience != null || c.softness != null"
                    class="text-xs text-neutral-500"
                  >
                    耐心 {{ c.patience ?? '—' }} · 心软 {{ c.softness ?? '—' }}
                  </p>
                </div>
              </div>

              <div
                v-if="c.personality?.length"
                class="flex flex-wrap gap-1"
              >
                <UBadge
                  v-for="t in c.personality"
                  :key="t"
                  color="neutral"
                  variant="soft"
                  :label="t"
                />
              </div>

              <p
                v-if="c.background"
                class="line-clamp-3 text-xs text-neutral-500"
              >
                {{ c.background }}
              </p>
            </UCard>
          </button>
        </div>

        <div class="flex justify-end pt-4">
          <UButton
            icon="i-lucide-play"
            color="primary"
            :loading="creating"
            :disabled="!selected || creating"
            @click="createGame"
          >
            以{{ selected ? `「${selected}」` : '' }}的身份进入故事
          </UButton>
        </div>
      </div>

      <!-- 会话已创建 -->
      <div
        v-else
        class="space-y-5"
      >
        <UCard class="space-y-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-xl font-semibold">
                你以「{{ created.player_character_name }}」的身份进入了「{{ created.world?.title || world?.title }}」
              </h2>
              <p class="text-sm text-neutral-500">
                会话状态：{{ created.status }} · 模式：{{ created.mode }}
              </p>
            </div>
            <UBadge
              color="success"
              variant="soft"
              label="已创建"
            />
          </div>

          <div class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
              <p class="text-xs text-neutral-500">
                HP
              </p>
              <p class="font-semibold tabular-nums">
                {{ created.state?.hp ?? '—' }}
              </p>
            </div>
            <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
              <p class="text-xs text-neutral-500">
                金钱
              </p>
              <p class="font-semibold tabular-nums">
                {{ created.state?.money ?? '—' }}
              </p>
            </div>
            <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
              <p class="text-xs text-neutral-500">
                地点
              </p>
              <p class="truncate font-semibold">
                {{ created.state?.location || '未知' }}
              </p>
            </div>
            <div class="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
              <p class="text-xs text-neutral-500">
                关系
              </p>
              <p class="truncate font-semibold tabular-nums">
                {{ Object.keys(created.state?.relationships ?? {}).length }} 人
              </p>
            </div>
          </div>

          </UCard>

        <div class="flex gap-2">
          <UButton
            label="进入 AI 首幕"
            color="primary"
            icon="i-lucide-play"
            :to="`/games/${created.id}`"
          />
          <UButton
            label="重新选择"
            color="neutral"
            variant="outline"
            @click="created = null; selected = null"
          />
        </div>
      </div>
    </div>
  </div>
</template>
