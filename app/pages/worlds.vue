<script setup lang="ts">
// 我的世界:展示本地 IndexedDB 保存的人物卡库(characterStore),支持删除与进入选角
useHead({ title: 'AIStoryBound · 我的世界' })

import { listWorlds, deleteWorld, type SavedWorld } from '../utils/characterStore'

const worlds = ref<SavedWorld[]>([])
const loading = ref(true)
const deleteOpen = ref(false)
const deleting = ref<SavedWorld | null>(null)
const busy = ref(false)

async function load() {
  loading.value = true
  try {
    worlds.value = await listWorlds()
  } finally {
    loading.value = false
  }
}

onMounted(load)

function askDelete(world: SavedWorld) {
  deleting.value = world
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!deleting.value || busy.value) return
  busy.value = true
  try {
    await deleteWorld(deleting.value.novelId)
    worlds.value = worlds.value.filter(w => w.novelId !== deleting.value?.novelId)
    deleting.value = null
    deleteOpen.value = false
  } finally {
    busy.value = false
  }
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function roleBadgeColor(role?: string) {
  if (role === '主角') return 'primary' as const
  if (role === '反派') return 'error' as const
  return 'neutral' as const
}

/** 头像底色与文字色按角色身份区分(静态类名,保证 Tailwind 可扫描) */
const roleAvatarClass: Record<string, string> = {
  主角: 'bg-primary-500/15 text-primary-500',
  反派: 'bg-error-500/15 text-error-500',
  配角: 'bg-neutral-500/15 text-neutral-500'
}
function avatarClass(role?: string) {
  return roleAvatarClass[role ?? ''] ?? 'bg-neutral-500/15 text-neutral-500'
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-4 py-8">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-semibold">
          我的世界
        </h1>
        <UBadge
          v-if="!loading && worlds.length"
          :label="String(worlds.length)"
          color="neutral"
          variant="soft"
          size="sm"
        />
      </div>
      <UButton
        icon="i-lucide-refresh-cw"
        label="刷新"
        color="neutral"
        variant="ghost"
        size="sm"
        :loading="loading"
        @click="load"
      />
    </div>

    <!-- 加载中 -->
    <div
      v-if="loading"
      class="mt-6 grid gap-4 md:grid-cols-2"
    >
      <USkeleton
        v-for="i in 2"
        :key="i"
        class="h-48"
      />
    </div>

    <!-- 空状态 -->
    <div
      v-else-if="worlds.length === 0"
      class="flex flex-col items-center gap-3 py-24 text-center"
    >
      <UIcon
        name="i-lucide-library"
        class="size-10 text-neutral-300 dark:text-neutral-600"
      />
      <p class="max-w-sm text-sm text-neutral-500">
        还没有保存的角色卡。上传一本小说并完成 AI 解析后,人物卡与世界观会自动保存在这里。
      </p>
      <UButton
        to="/"
        icon="i-lucide-upload"
        label="上传小说"
        color="primary"
      />
    </div>

    <!-- 世界卡片列表 -->
    <div
      v-else
      class="mt-6 grid gap-4 md:grid-cols-2"
    >
      <UCard
        v-for="w in worlds"
        :key="w.novelId"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">
              {{ w.title || '未命名故事' }}
            </h2>
            <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <UBadge
                v-if="w.genre"
                :label="w.genre"
                color="neutral"
                variant="soft"
                size="sm"
              />
              <span>{{ formatTime(w.savedAt) }}</span>
            </div>
          </div>
        </div>

        <p
          v-if="w.summary"
          class="mt-3 line-clamp-2 text-sm text-neutral-600 dark:text-neutral-300"
        >
          {{ w.summary }}
        </p>

        <div class="mt-4 grid gap-2 sm:grid-cols-2">
          <div
            v-for="c in w.characters"
            :key="c.name"
            class="flex items-center gap-2.5 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
          >
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
              :class="avatarClass(c.role)"
            >
              {{ c.name.charAt(0) }}
            </span>
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">
                {{ c.name }}
              </p>
              <p class="truncate text-xs text-neutral-500">
                {{ c.role || '角色' }}{{ c.identity ? ` · ${c.identity}` : '' }}{{ c.age ? ` · ${c.age}` : '' }}
              </p>
            </div>
            <UBadge
              :label="c.role || '角色'"
              :color="roleBadgeColor(c.role)"
              variant="soft"
              size="xs"
              class="ml-auto shrink-0"
            />
          </div>
          <p
            v-if="w.characters.length === 0"
            class="col-span-full text-xs text-neutral-500"
          >
            该故事暂无人物卡数据
          </p>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              icon="i-lucide-trash-2"
              label="删除"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="askDelete(w)"
            />
            <UButton
              icon="i-lucide-user-round"
              label="选择角色开始"
              color="primary"
              variant="soft"
              size="sm"
              :to="`/novels/${w.novelId}/select`"
            />
          </div>
        </template>
      </UCard>
    </div>
  </div>

  <!-- 删除确认 -->
  <UModal
    v-model:open="deleteOpen"
    :title="`删除「${deleting?.title || '未命名故事'}」?`"
    description="将删除本地保存的人物卡,删除后无法恢复。"
  >
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          label="取消"
          color="neutral"
          variant="ghost"
          @click="deleteOpen = false"
        />
        <UButton
          icon="i-lucide-trash-2"
          label="删除"
          color="error"
          :loading="busy"
          @click="confirmDelete"
        />
      </div>
    </template>
  </UModal>
</template>