<script setup lang="ts">
// 首页 Hero:徽章 + 渐变标题 + 双 CTA + 能力指标 + 产品演示窗口。
// 背景为网格纹理 + 品牌绿光晕 + 飘浮光斑,明暗各一套。
import { useAuthModal } from '~/composables/useAuthModal'

const { requireLogin } = useAuthModal()

async function onStartGenerate() {
  const ok = await requireLogin()
  if (ok) navigateTo('/generate')
}
</script>

<template>
  <section class="relative overflow-hidden">
    <!-- 背景装饰(网格 + 光晕 + 飘浮光斑) -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0"
    >
      <div class="bg-grid absolute inset-0" />
      <div class="absolute -top-40 left-1/2 h-[480px] w-[760px] -translate-x-1/2 rounded-full bg-primary-400/20 blur-3xl dark:bg-primary-500/10" />
      <div class="animate-drift absolute left-[6%] top-44 size-40 rounded-full bg-primary-300/20 blur-3xl dark:bg-primary-600/10" />
      <div
        class="animate-drift absolute right-[4%] top-72 size-56 rounded-full bg-primary-500/15 blur-3xl dark:bg-primary-700/10"
        style="animation-delay: -4s"
      />
    </div>

    <div class="relative mx-auto max-w-6xl px-4 pb-16 pt-16 text-center sm:pt-24">
      <p class="mx-auto mb-5 inline-flex items-center gap-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 px-3.5 py-1.5 text-xs text-primary-600 dark:text-primary-400">
        <UIcon
          name="i-lucide-wand-sparkles"
          class="size-3.5"
        />
        AI 驱动 · 本地优先 · 世界观一致
      </p>

      <h1 class="mx-auto max-w-3xl text-4xl font-bold leading-tight tracking-tight text-(--ui-text-highlighted) sm:text-5xl">
        把每一本小说,变成<br>
        <span class="text-gradient">真实可互动的世界</span>
      </h1>

      <p class="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-lg">
        AI 分章提取人物、地点、势力、规则与伏笔,自动合并校验后生成完整世界观。
        选择一个角色,在原著的世界里自由行动,改变故事的走向。
      </p>

      <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
        <UButton
          color="primary"
          size="lg"
          icon="i-lucide-sparkles"
          @click="onStartGenerate"
        >
          开始生成世界
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          size="lg"
          icon="i-lucide-arrow-right"
          to="#how"
        >
          看看怎么玩
        </UButton>
      </div>

      <p class="mt-5 flex items-center justify-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-500">
        <UIcon
          name="i-lucide-lock"
          class="size-3.5"
        />
        正文只在本地解析与存档 · 可绑定自己的 API Key
      </p>

      <!-- 产品演示 -->
      <LandingProductMockup />

      <!-- 能力指标(产品真实能力,非虚构成绩) -->
      <dl class="mx-auto mt-12 grid max-w-4xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-200 text-left dark:border-neutral-800 dark:bg-neutral-800 sm:grid-cols-4">
        <div class="bg-white px-5 py-4 dark:bg-neutral-950">
          <dt class="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <UIcon
              name="i-lucide-brain-circuit"
              class="size-3.5 text-primary"
            />
            五类实体
          </dt>
          <dd class="mt-1 text-sm font-semibold text-(--ui-text-highlighted)">
            人物 · 地点 · 势力 · 规则 · 伏笔
          </dd>
        </div>
        <div class="bg-white px-5 py-4 dark:bg-neutral-950">
          <dt class="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <UIcon
              name="i-lucide-quote"
              class="size-3.5 text-primary"
            />
            原文溯源
          </dt>
          <dd class="mt-1 text-sm font-semibold text-(--ui-text-highlighted)">
            每条设定带章节出处
          </dd>
        </div>
        <div class="bg-white px-5 py-4 dark:bg-neutral-950">
          <dt class="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <UIcon
              name="i-lucide-shield-check"
              class="size-3.5 text-primary"
            />
            OOC 防护
          </dt>
          <dd class="mt-1 text-sm font-semibold text-(--ui-text-highlighted)">
            人物卡锁定性格边界
          </dd>
        </div>
        <div class="bg-white px-5 py-4 dark:bg-neutral-950">
          <dt class="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <UIcon
              name="i-lucide-rotate-ccw"
              class="size-3.5 text-primary"
            />
            随时回滚
          </dt>
          <dd class="mt-1 text-sm font-semibold text-(--ui-text-highlighted)">
            每回合可重选分支
          </dd>
        </div>
      </dl>
    </div>
  </section>
</template>