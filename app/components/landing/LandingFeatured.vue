<script setup lang="ts">
// 推荐作品:拉取官方预置小说(/api/presets,featured=1),公开接口。
// 双行反向 Marquee 跑马灯(参考官方 testimonials 示例),只展示作品名与作者;接口失败/为空时优雅降级。
import type { PresetNovelRow } from '#shared/novel'

const { data: presets, status } = await useAsyncData('landing-featured', () =>
  $fetch<PresetNovelRow[]>('/api/presets').catch(() => [])
)

// 作品拆成上下两行,避免同一作品在两条跑马灯里重复出现;过滤掉可能的空行
const rows = computed(() =>
  [
    (presets.value ?? []).filter((_, i) => i % 2 === 0),
    (presets.value ?? []).filter((_, i) => i % 2 === 1)
  ].filter((row) => row.length > 0)
)

// 作品名:有的标题带括号标注(如「救命索(年上 强制 调教 H)」),只取括号前的部分并加书名号
function bookTitle(title: string) {
  return `《${(title.split(/[（(]/)[0] ?? '').trim()}》`
}
</script>

<template>
  <section class="border-t border-neutral-200/70 dark:border-neutral-800/70">
    <div class="mx-auto max-w-6xl px-4 py-20">
      <div class="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-xs font-semibold tracking-widest text-primary-600 dark:text-primary-400">
            官方精选
          </p>
          <h2 class="mt-2 text-2xl font-bold tracking-tight text-(--ui-text-highlighted) sm:text-3xl">
            推荐作品
          </h2>
          <p class="mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            选好自己想要代入的角色,点击即可直接生成世界观开始游玩。
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-library-big"
          to="/works"
        >
          去书架逛逛
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

      <!-- 数据为空:占位提示 -->
      <div
        v-else-if="!presets?.length"
        class="rounded-2xl border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700"
      >
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
          官方预置小说正在上架中——先上传一本你最喜欢的书,马上就能开始玩。
        </p>
      </div>

      <!-- 双行反向跑马灯:只展示作品名与作者,点击进入作品页 -->
      <div
        v-else
        class="flex flex-col gap-4"
      >
        <UMarquee
          v-for="(row, r) in rows"
          :key="r"
          pause-on-hover
          :reverse="r === 1"
          :overlay="false"
          :ui="{ root: '[--gap:--spacing(6)]', content: 'w-auto py-1' }"
        >
          <NuxtLink
            v-for="p in row"
            :key="p.id"
            :to="`/presets/${p.id}`"
            class="flex w-48 shrink-0 flex-col rounded-xl border border-neutral-200 bg-white px-4 py-3 transition-colors hover:border-primary-500/40 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30"
          >
            <span class="truncate font-semibold text-(--ui-text-highlighted)">
              {{ bookTitle(p.title) }}
            </span>
            <span
              v-if="p.author"
              class="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400"
            >
              {{ p.author }}
            </span>
          </NuxtLink>
        </UMarquee>
      </div>
    </div>
  </section>
</template>