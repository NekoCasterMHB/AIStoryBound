<script setup lang="ts">
import { useAuthSession } from '../utils/auth-client'
import { useAuthModal } from '../composables/useAuthModal'
import { DEMAND_STATUS_LABELS, MAX_DEMAND_DESC_CHARS, MAX_DEMAND_TITLE_CHARS } from '#shared/demand'
import type { DemandItem, DemandStatus } from '#shared/demand'

// /demand — 需求墙(游客可浏览;发起需求与点赞需登录)。按点赞数排序,高赞需求优先实现。
useHead({ title: 'AI Word2World · 需求墙' })

await useAuthSession()
const { requireLogin } = useAuthModal()
const toast = useToast()

/** 状态徽章颜色(管理端标记后用户侧同步展示) */
const STATUS_BADGE_COLORS: Record<DemandStatus, 'neutral' | 'primary' | 'success'> = {
  open: 'neutral',
  in_progress: 'primary',
  done: 'success'
}

// ---- 数据 ----
const demands = ref<DemandItem[]>([])
// 初始即 true:避免首帧渲染出"还没有需求"空状态(onMounted 前 loading 为 false)
const loading = ref(true)

async function loadDemands() {
  loading.value = true
  try {
    demands.value = await $fetch<DemandItem[]>('/api/demand')
  } catch (e) {
    toast.add({ title: '加载需求墙失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void loadDemands()
})

function fmtTs(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}

// ---- 状态分组(未完成=open+in_progress,已完成=done;默认展示未完成) ----
const activeTab = ref<'pending' | 'done'>('pending')
const demandTabs = [
  { label: '未完成', icon: 'i-lucide-hourglass', value: 'pending' as const },
  { label: '已完成', icon: 'i-lucide-check-circle', value: 'done' as const }
]
const pendingDemands = computed(() => demands.value.filter(d => d.status !== 'done'))
const doneDemands = computed(() => demands.value.filter(d => d.status === 'done'))
const visibleDemands = computed(() => activeTab.value === 'done' ? doneDemands.value : pendingDemands.value)

// ---- 点赞(toggle,本地即时更新) ----
const likingIds = ref<Set<string>>(new Set())

async function onLike(d: DemandItem) {
  const ok = await requireLogin()
  if (!ok || likingIds.value.has(d.id)) return
  likingIds.value.add(d.id)
  try {
    const res = await $fetch<{ ok: true, liked: boolean, likeCount: number }>(`/api/demand/${d.id}/like`, { method: 'POST' })
    d.liked = res.liked
    d.likeCount = res.likeCount
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    likingIds.value.delete(d.id)
  }
}

// ---- 发起需求 ----
const createOpen = ref(false)
const creating = ref(false)
const createTitle = ref('')
const createDesc = ref('')

async function onCreate() {
  const ok = await requireLogin()
  if (!ok) return
  createTitle.value = ''
  createDesc.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (creating.value) return
  creating.value = true
  try {
    const item = await $fetch<DemandItem>('/api/demand', {
      method: 'POST',
      body: { title: createTitle.value, desc: createDesc.value }
    })
    createOpen.value = false
    // 插入列表顶部(点赞数 1 的新需求,后端排序下紧随高赞需求)
    demands.value.unshift(item)
    toast.add({ title: '需求已发布', description: '你的需求已登上需求墙,高赞的会优先实现', color: 'success' })
  } catch (e) {
    toast.add({ title: '发布失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-6">
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          需求墙
        </h1>
        <p class="mt-1 text-sm text-neutral-500">
          告诉我们你想要什么功能——按点赞数排序,高赞的会优先实现
        </p>
      </div>
      <UButton
        color="primary"
        icon="i-lucide-message-square-plus"
        @click="onCreate"
      >
        发起需求
      </UButton>
    </div>

    <!-- 加载中 / 空状态 / 列表 -->
    <div
      v-if="loading"
      class="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      加载中…
    </div>
    <div
      v-else-if="!demands.length"
      class="py-10 text-center text-sm text-neutral-500"
    >
      还没有需求,成为第一个提出需求的人吧
    </div>
    <template v-else>
      <UTabs
        v-model="activeTab"
        :items="demandTabs"
        variant="link"
        color="primary"
        class="mb-4"
      />
      <div
        v-if="!visibleDemands.length"
        class="py-10 text-center text-sm text-neutral-500"
      >
        {{ activeTab === 'done' ? '还没有已实现的需求' : '当前没有未完成的需求,看看已完成的有哪些吧' }}
      </div>
      <div
        v-else
        class="flex flex-col gap-3"
      >
        <UCard
          v-for="d in visibleDemands"
          :key="d.id"
          class="flex flex-col"
        >
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 font-semibold">
                <span class="min-w-0">{{ d.title }}</span>
                <UBadge
                  v-if="d.status !== 'open'"
                  size="sm"
                  :color="STATUS_BADGE_COLORS[d.status]"
                  variant="soft"
                  :icon="d.status === 'done' ? 'i-lucide-check' : (d.status === 'in_progress' ? 'i-lucide-hammer' : undefined)"
                  leading
                  class="shrink-0"
                >
                  {{ DEMAND_STATUS_LABELS[d.status] }}
                </UBadge>
              </p>
              <p class="mt-1 whitespace-pre-line text-sm text-neutral-600 dark:text-neutral-400">
                {{ d.desc }}
              </p>
              <p class="mt-2 text-xs text-neutral-400">
                {{ d.authorName }} · {{ fmtTs(d.createdAt) }}
              </p>
            </div>
            <!-- 点赞:未登录点击弹登录框 -->
            <UButton
              :color="d.liked ? 'primary' : 'neutral'"
              :variant="d.liked ? 'solid' : 'outline'"
              size="sm"
              icon="i-lucide-thumbs-up"
              :loading="likingIds.has(d.id)"
              class="shrink-0 tabular-nums"
              @click="onLike(d)"
            >
              {{ d.likeCount }}
            </UButton>
          </div>
        </UCard>
      </div>
    </template>

    <!-- 发起需求表单 -->
    <UModal
      v-model:open="createOpen"
      title="发起新需求"
      description="写清楚你想要的功能,高赞的会优先实现"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField label="标题">
            <UInput
              v-model="createTitle"
              placeholder="一句话描述你想要的功能"
              :maxlength="MAX_DEMAND_TITLE_CHARS"
              class="w-full"
            />
            <template #hint>
              {{ createTitle.length }}/{{ MAX_DEMAND_TITLE_CHARS }}
            </template>
          </UFormField>
          <UFormField label="详细描述">
            <UTextarea
              v-model="createDesc"
              placeholder="说明使用场景、期望的效果,越具体越好"
              :maxlength="MAX_DEMAND_DESC_CHARS"
              :rows="4"
              autoresize
              :maxrows="12"
              class="w-full"
            />
            <template #hint>
              {{ createDesc.length }}/{{ MAX_DEMAND_DESC_CHARS }}
            </template>
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="outline"
            @click="createOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="primary"
            :loading="creating"
            @click="submitCreate"
          >
            发布需求
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
