<script setup lang="ts">
// 结尾 CTA 横幅:渐变面板 + 登录链路。
import { useAuthModal } from '~/composables/useAuthModal'

const { requireLogin } = useAuthModal()

async function onStartGenerate() {
  const ok = await requireLogin()
  if (ok) navigateTo('/generate')
}
</script>

<template>
  <section class="border-t border-neutral-200/70 dark:border-neutral-800/70">
    <div class="mx-auto max-w-6xl px-4 py-20">
      <div
        v-reveal
        class="relative overflow-hidden rounded-3xl border border-primary-500/25 bg-gradient-to-br from-primary-500/10 via-transparent to-primary-400/10 px-6 py-16 text-center dark:border-primary-500/20 dark:from-primary-500/12 dark:to-primary-400/8"
      >
        <!-- 装饰光斑 -->
        <div
          aria-hidden="true"
          class="pointer-events-none absolute inset-0"
        >
          <div class="bg-grid absolute inset-0 opacity-60" />
          <div class="animate-drift absolute -left-16 -top-16 size-48 rounded-full bg-primary-400/20 blur-3xl dark:bg-primary-500/12" />
          <div
            class="animate-drift absolute -bottom-20 -right-10 size-56 rounded-full bg-primary-300/20 blur-3xl dark:bg-primary-600/12"
            style="animation-delay: -5s"
          />
        </div>

        <div class="relative">
          <h2 class="text-2xl font-bold tracking-tight text-(--ui-text-highlighted) sm:text-3xl">
            准备好了吗?<br>
            把你最爱的书,变成<span class="text-gradient">可以走进去的世界</span>
          </h2>
          <p class="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            免费开始。无需任何配置,上传一本 TXT,几分钟后你就能在故事里扮演角色。
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
              icon="i-lucide-library-big"
              to="/works"
            >
              去书架逛逛
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>