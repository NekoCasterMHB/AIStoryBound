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
          本回合 2,437 tokens
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
            第 12 章 · 留堂之后
          </UBadge>
          <UBadge
            color="neutral"
            variant="soft"
            icon="i-lucide-book-open"
          >
            原著《她永远不乖》
          </UBadge>
          <UBadge
            color="neutral"
            variant="soft"
            icon="i-lucide-history"
          >
            已回滚 3 次
          </UBadge>
        </div>

        <!-- 角色卡 -->
        <div class="mb-4 flex items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-100/70 p-3 dark:border-white/10 dark:bg-white/5">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-primary-400/40 to-primary-500/40 text-xl">
            👔
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-neutral-900 dark:text-white">夏远安</span>
              <span class="truncate text-xs text-neutral-500 dark:text-neutral-400">日语老师 · 你的专属管教者</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span>威严 <span class="font-mono text-neutral-800 dark:text-neutral-300">92</span></span>
              <span>耐心 <span class="font-mono text-neutral-800 dark:text-neutral-300">18</span></span>
              <span>欲望 <span class="font-mono text-neutral-800 dark:text-neutral-300">37</span></span>
              <span class="text-rose-600/90 dark:text-rose-400/90">⦿ 支配阵营 · 管教中</span>
            </div>
          </div>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 shrink-0 text-neutral-400 dark:text-neutral-500"
          />
        </div>

        <!-- 叙事气泡 -->
        <div class="space-y-2.5 rounded-xl rounded-tl-sm border border-neutral-200 bg-neutral-100/70 px-4 py-3 text-sm leading-relaxed text-neutral-700 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200">
          <p>「作业的事,留堂再说。」放学后的教室只剩你们两人,夕阳把课桌的影子拉得很长。</p>
          <p>夏远安拉过椅子坐下,拍了拍自己的膝盖,示意你过去;戒尺在他掌心敲了两下,不重,却让你的心跳漏了一拍。</p>
          <p>「规矩你都还记得——趴好,不许躲,自己数数,数错了加一。」他看着你,声音低而稳,像在讲一道再普通不过的语法题;你挪过去的每一步,耳根都在发烫——<span class="text-primary-600 dark:text-primary-300">今晚的规矩,你自己清楚</span>。</p>
        </div>

        <!-- 选项 -->
        <div class="mt-3 space-y-2">
          <div class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-primary-500/40 bg-primary-500/10 px-4 py-2.5 text-left text-sm text-primary-700 transition hover:border-primary-500/70 hover:bg-primary-500/15 dark:border-primary-400/30 dark:bg-primary-400/10 dark:text-primary-100 dark:hover:border-primary-400/60 dark:hover:bg-primary-400/15">
            <span>红着脸走过去趴好,小声认错求轻罚。</span>
            <UIcon
              name="i-lucide-arrow-right"
              class="size-4 shrink-0 text-primary-500 dark:text-primary-400"
            />
          </div>
          <div class="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-100/70 px-4 py-2.5 text-left text-sm text-neutral-700 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200">
            <span>咬着唇一言不发,倔强地绷紧身体。</span>
            <UIcon
              name="i-lucide-arrow-right"
              class="size-4 shrink-0 text-neutral-400 dark:text-neutral-500"
            />
          </div>
          <div class="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-100/70 px-4 py-2.5 text-left text-sm text-neutral-700 dark:border-white/10 dark:bg-white/5 dark:text-neutral-200">
            <span>轻声说出安全词「红灯」,试探他的底线。</span>
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
