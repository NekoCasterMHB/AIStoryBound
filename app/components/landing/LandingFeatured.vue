<script setup lang="ts">
// 推荐作品:拉取官方预置小说(/api/presets,featured=1),公开接口。
// 封面无图片素材,用 emoji + 渐变底做视觉化处理;接口失败/为空时优雅降级。
import type { PresetNovelRow } from '#shared/novel'

// 与 works.vue 相同的字数格式化
function fmtChars(n?: number) {
  if (!n || n <= 0) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`
  if (n >= 1000) return `${(n / 1000).toFixed(1)} 千字`
  return `${n} 字`
}

const { data: presets, status } = await useAsyncData('landing-featured', () =>
  $fetch<PresetNovelRow[]>('/api/presets').catch(() => [])
)

// emoji 封面衬底的渐变,按顺序循环
const coverGradients = [
  'from-green-500/20 to-teal-500/20',
  'from-teal-500/20 to-cyan-500/20',
  'from-emerald-500/20 to-green-500/20',
  'from-cyan-500/20 to-sky-500/20'
]
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
        class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div
          v-for="i in 3"
          :key="i"
          class="animate-pulse overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800"
        >
          <div class="h-28 bg-neutral-100 dark:bg-neutral-800" />
          <div class="space-y-2 p-5">
            <div class="h-4 w-2/3 rounded bg-neutral-100 dark:bg-neutral-800" />
            <div class="h-3 w-1/3 rounded bg-neutral-100 dark:bg-neutral-800" />
            <div class="h-3 w-full rounded bg-neutral-100 dark:bg-neutral-800" />
          </div>
        </div>
      </div>

      <!-- 数据为空:占位提示 -->
      <div
        v-else-if="!presets?.length"
        class="rounded-2xl border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700"
      >
        <UIcon
          name="i-lucide-book-open"
          class="mx-auto size-8 text-neutral-400"
        />
        <p class="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          官方预置小说正在上架中——先上传一本你最喜欢的书,马上就能开始玩。
        </p>
      </div>

      <!-- 作品卡片 -->
      <div
        v-else
        class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <NuxtLink
          v-for="(p, i) in presets"
          :key="p.id"
          v-reveal
          :to="`/presets/${p.id}`"
          class="group overflow-hidden rounded-2xl border border-neutral-200 bg-white transition duration-300 hover:-translate-y-1 hover:border-primary-500/40 hover:shadow-[0_16px_40px_-16px_rgb(0_193_106/0.3)] dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30 dark:hover:shadow-[0_16px_40px_-16px_rgb(0_220_130/0.15)]"
        >
          <div
            class="flex h-28 items-center justify-center bg-gradient-to-br"
            :class="coverGradients[i % coverGradients.length]"
          >
            <span
              class="text-5xl drop-shadow-sm transition-transform duration-300 group-hover:scale-110"
              aria-hidden="true"
            >
              {{ p.cover_emoji || '📖' }}
            </span>
          </div>
          <div class="p-5">
            <div class="flex items-center gap-2">
              <h3 class="min-w-0 flex-1 truncate font-semibold text-(--ui-text-highlighted)">
                {{ p.title }}
              </h3>
              <UBadge
                v-if="p.genre"
                color="neutral"
                variant="soft"
              >
                {{ p.genre }}
              </UBadge>
            </div>
            <p
              v-if="p.author"
              class="mt-1 text-xs text-neutral-500 dark:text-neutral-400"
            >
              {{ p.author }}
            </p>
            <p
              v-if="p.description"
              class="mt-2 line-clamp-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400"
            >
              {{ p.description }}
            </p>
            <div class="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-500">
              <span>{{ p.chapter_count ?? 0 }} 章 · {{ fmtChars(p.char_count) }}</span>
              <span class="flex items-center gap-1">
                <UIcon
                  name="i-lucide-download"
                  class="size-3.5"
                />
                {{ p.download_count ?? 0 }}
              </span>
            </div>
          </div>
        </NuxtLink>
      </div>
    </div>
  </section>
</template>