<script setup lang="ts">
// /games/continue — 作品+角色的存档列表(从书架「继续游戏」进入):
// 列出该角色在本地作品下的全部游戏会话,可继续游玩或删除(删除时一并清理该会话的存档点)
import { getWork } from '../../utils/worldGen'
import { listLocalGames, deleteLocalGame } from '../../utils/gameStore'
import { deleteGamePoints } from '../../utils/gameSaveStore'
import type { LocalGame, LocalWork } from '#shared/novel'

useHead({ title: 'AI Word2World · 继续游戏' })

const route = useRoute()
const toast = useToast()
const workId = String(route.query.workId ?? '')
const character = String(route.query.character ?? '')

const work = ref<LocalWork | null>(null)
const games = ref<LocalGame[]>([])
const loadError = ref<string | null>(null)
const deleting = ref<string | null>(null)
const confirmDeleteId = ref<string | null>(null)

async function load() {
  const [w, all] = await Promise.all([getWork(workId), listLocalGames()])
  work.value = w
  if (!w) loadError.value = '本地未找到该作品'
  games.value = all
    .filter(g => g.workId === workId && g.characterName === character)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

onMounted(load)

async function doDelete() {
  const target = games.value.find(g => g.id === confirmDeleteId.value)
  confirmDeleteId.value = null
  if (!target) return
  deleting.value = target.id
  try {
    await deleteLocalGame(target.id)
    await deleteGamePoints(target.id)
    toast.add({ title: '已删除该存档', color: 'success' })
    await load()
  } catch (e) {
    toast.add({ title: '删除失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    deleting.value = null
  }
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="flex items-center gap-2 text-xl font-semibold">
          <UIcon
            name="i-lucide-rotate-ccw"
            class="size-5 text-primary"
          />
          继续游戏
        </h1>
        <p class="text-sm text-neutral-500">
          《{{ work?.title || '作品' }}》 · 你是「{{ character }}」
        </p>
      </div>
      <UButton
        label="返回书架"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="outline"
        size="sm"
        to="/works"
      />
    </div>

    <UAlert
      v-if="loadError"
      color="error"
      variant="soft"
      :title="loadError"
    />

    <div
      v-if="games.length === 0 && !loadError"
      class="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700"
    >
      「{{ character }}」还没有存档——去
      <NuxtLink
        :to="`/play/${workId}`"
        class="text-primary-500 underline"
      >选择角色</NuxtLink>
      开始新的一局
    </div>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <UCard
        v-for="g in games"
        :key="g.id"
        class="flex flex-col"
      >
        <p class="text-sm font-semibold">
          你是「{{ g.playerName }}」
        </p>
        <p class="mt-1 truncate text-xs text-neutral-500">
          {{ g.currentChapter || '进行中' }} · {{ g.messages.length }} 条剧情
        </p>
        <p class="mt-1 text-xs text-neutral-500">
          最后游玩: {{ fmtTime(g.updatedAt) }}
        </p>
        <div class="mt-3 flex flex-wrap gap-1.5">
          <UButton
            label="继续"
            icon="i-lucide-play"
            color="primary"
            size="sm"
            :to="`/games/${g.id}`"
          />
          <UButton
            label="删除"
            icon="i-lucide-trash-2"
            color="error"
            variant="outline"
            size="sm"
            :loading="deleting === g.id"
            @click="confirmDeleteId = g.id"
          />
        </div>
      </UCard>
    </div>

    <!-- 删除确认 -->
    <UModal
      :open="confirmDeleteId !== null"
      @update:open="confirmDeleteId = null"
    >
      <template #title>
        删除存档
      </template>
      <template #body>
        <p class="text-sm">
          确定删除「{{ character }}」的这局存档么?删除后不可恢复。
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="取消"
            color="neutral"
            variant="outline"
            @click="confirmDeleteId = null"
          />
          <UButton
            label="删除"
            icon="i-lucide-trash-2"
            color="error"
            :loading="deleting !== null"
            @click="doDelete"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
