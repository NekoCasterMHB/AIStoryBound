<script setup lang="ts">
// 首页 Hero 的产品演示:纯 CSS 模拟的游玩界面(角色卡 + 叙事 + 选项),"屏幕"跟随页面明暗主题自适应。
</script>

<template>
  <div
    class="animate-mockup-in relative mx-auto mt-14 max-w-3xl"
    aria-hidden="true"
  >
    <!-- 底部光晕,把"屏幕"托起来 -->
    <div
      class="absolute -inset-x-6 -bottom-8 top-16 rounded-[3rem] bg-linear-to-r from-primary-400/25 via-primary-300/20 to-primary-500/25 blur-3xl dark:from-primary-500/15 dark:via-primary-600/12 dark:to-primary-700/15"
    />

    <div class="relative overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-[0_24px_64px_-28px_rgb(0_0_0/0.28)] ring-1 ring-black/5 dark:border-white/10 dark:bg-neutral-950 dark:shadow-[0_32px_80px_-32px_rgb(0_0_0/0.45)] dark:ring-white/10">
      <!-- 窗口顶栏 -->
      <div class="flex items-center gap-2 border-b border-neutral-200/80 px-4 py-3 dark:border-white/10">
        <span class="size-2.5 rounded-full bg-red-400/80" />
        <span class="size-2.5 rounded-full bg-yellow-400/80" />
        <span class="size-2.5 rounded-full bg-green-400/80" />
        <span class="ml-3 truncate text-xs text-neutral-500">
          AI Word2World · 互动游玩
        </span>
        <span class="ml-auto hidden items-center gap-1.5 text-[11px] text-neutral-500 sm:flex">
          <UIcon
            name="i-lucide-zap"
            class="size-3 text-primary-500 dark:text-primary-400"
          />
          本回合 128 tokens
        </span>
      </div>

      <div class="p-5 text-left sm:p-6">
        <!-- 当前场景 -->
        <div class="mb-4 flex flex-wrap items-center gap-2">
          <UBadge
            color="primary"
            variant="soft"
            icon="i-lucide-map-pin"
          >
            第三章 · 烟雨楼
          </UBadge>
          <UBadge
            color="neutral"
            variant="soft"
            icon="i-lucide-book-open"
          >
            原著《长夜行》
          </UBadge>
          <UBadge
            color="neutral"
            variant="soft"
            icon="i-lucide-history"
          >
            已回滚 2 次
          </UBadge>
        </div>

        <!-- 角色卡 -->
        <div class="mb-4 flex items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-100/70 p-3 dark:border-white/10 dark:bg-white/5">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-primary-400/40 to-primary-500/40 text-xl">
            🧙
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-neutral-900 dark:text-white">青璃</span>
              <span class="truncate text-xs text-neutral-500 dark:text-neutral-400">宗门弟子 · 忠于门派</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span>耐心 <span class="font-mono text-neutral-800 dark:text-neutral-300">72</span></span>
              <span>心软 <span class="font-mono text-neutral-800 dark:text-neutral-300">58</span></span>
              <span>警惕 <span class="font-mono text-neutral-800 dark:text-neutral-300">81</span></span>
              <span class="text-primary-600/90 dark:text-primary-400/90">⦿ 正派阵营</span>
            </div>
          </div>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 shrink-0 text-neutral-400 dark:text-neutral-500"
          />
        </div>

        <!-- 叙事气泡 -->
        <div class="rounded-xl rounded-tl-sm border border-neutral-200 bg-neutral-100/70 px-4 py-3 text-sm leading-relaxed text-neutral-700 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200">
          掌柜压低了声音:「三更之后,码头东边会有一艘不发一灯的船。」他看了看你,把热酒轻轻推到你面前,<span class="text-primary-600 dark:text-primary-300">等待你的回答</span>。
        </div>

        <!-- 选项 -->
        <div class="mt-3 space-y-2">
          <div class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-primary-500/40 bg-primary-500/10 px-4 py-2.5 text-left text-sm text-primary-700 transition hover:border-primary-500/70 hover:bg-primary-500/15 dark:border-primary-400/30 dark:bg-primary-400/10 dark:text-primary-100 dark:hover:border-primary-400/60 dark:hover:bg-primary-400/15">
            <span>对他点点头,决定今夜去码头一看究竟。</span>
            <UIcon
              name="i-lucide-arrow-right"
              class="size-4 shrink-0 text-primary-500 dark:text-primary-400"
            />
          </div>
          <div class="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-100/70 px-4 py-2.5 text-left text-sm text-neutral-700 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200">
            <span>旁敲侧击,打听那艘船的来历。</span>
            <UIcon
              name="i-lucide-arrow-right"
              class="size-4 shrink-0 text-neutral-400 dark:text-neutral-500"
            />
          </div>
          <div class="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-100/70 px-4 py-2.5 text-left text-sm text-neutral-700 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200">
            <span>假装没听见,回房把门窗闩好。</span>
            <UIcon
              name="i-lucide-arrow-right"
              class="size-4 shrink-0 text-neutral-400 dark:text-neutral-500"
            />
          </div>
        </div>

        <!-- 输入条 -->
        <div class="mt-4 flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-100/70 px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
          <UIcon
            name="i-lucide-keyboard"
            class="size-4 shrink-0 text-neutral-400 dark:text-neutral-500"
          />
          <span class="min-w-0 flex-1 truncate text-xs text-neutral-500">
            输入你的行动,或从上方选项中选择…
          </span>
          <UIcon
            name="i-lucide-send"
            class="size-4 shrink-0 text-neutral-400 dark:text-neutral-600"
          />
        </div>
      </div>
    </div>
  </div>
</template>