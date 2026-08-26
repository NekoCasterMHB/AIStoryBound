<script setup lang="ts">
// 需求墙入口区块:拉取点赞最高的 3 条需求(公开接口),引导用户去需求墙点赞/提需求;
// 接口失败/为空时优雅降级(只保留入口按钮)。
import type { DemandItem } from '#shared/demand'

const { data: topDemands, status } = await useAsyncData('landing-demand-wall', () =>
  $fetch<DemandItem[]>('/api/demand').catch(() => [])
)

const visible = computed(() => (topDemands.value ?? []).slice(0, 3))
</script>

<template>
  <section class="border-t border-neutral-200/70 dark:border-neutral-800/70">
    <div class="mx-auto max-w-6xl px-4 py-20">
      <div class="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-xs font-semibold tracking-widest text-primary-600 dark:text-primary-400">
            需求墙
          </p>
          <h2 class="mt-2 text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
            想让我们做什么
          </h2>
          <p class="mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            把你的想法发到需求墙,大家点赞越多越优先实现——这里是最受欢迎的几个。
          </p>
        </div>
        <UButton
          color="primary"
          icon="i-lucide-message-square-plus"
          to="/demand"
        >
          去需求墙提需求
        </UButton>
      </div>

      <!-- 加载中骨架 -->
      <div
        v-if="status === 'pending'"
        class="space-y-4"
      >
        <div class="h-8 animate-pulse rounded-lg bg-neutral-200/60 dark:bg-neutral-800/60" />
        <div class="h-8 animate-pulse rounded-lg bg-neutral-200/60 dark:bg-neutral-800/60" />
      </div>

      <!-- 数据为空:降级为纯入口 -->
      <div
        v-else-if="!visible.length"
        class="rounded-2xl border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700"
      >
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
          还没有需求,去需求墙提出第一个建议吧。
        </p>
      </div>

      <!-- 高赞需求榜(前三名) -->
      <div
        v-else
        class="grid gap-4 sm:grid-cols-3"
      >
        <NuxtLink
          v-for="(d, i) in visible"
          :key="d.id"
          :to="'/demand'"
          class="group flex flex-col rounded-xl border border-neutral-200 bg-white p-5 transition-colors hover:border-primary-500/40 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30"
        >
          <div class="flex items-center gap-2">
            <span
              class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary"
            >{{ i + 1 }}</span>
            <span class="text-xs text-neutral-500 dark:text-neutral-400">
              {{ d.likeCount }} 赞
            </span>
          </div>
          <p class="mt-3 line-clamp-2 font-semibold leading-snug text-highlighted">
            {{ d.title }}
          </p>
          <p class="mt-2 line-clamp-2 text-sm text-neutral-500 dark:text-neutral-400">
            {{ d.desc }}
          </p>
        </NuxtLink>
      </div>
    </div>
  </section>
</template>