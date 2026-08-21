<script setup>
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'zh-CN'
  }
})

const title = 'AIStoryBound'
const description = 'AI 小说驱动互动游戏平台 —— 上传一本小说,选择一个身份,进入故事,并亲手改变原本的结局。'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description
})
</script>

<template>
  <UApp>
    <UHeader>
      <template #left>
        <NuxtLink
          to="/"
          class="flex items-center gap-1.5 text-lg font-bold tracking-tight text-(--ui-text-highlighted)"
        >
          <UIcon
            name="i-lucide-sparkles"
            class="size-5 text-primary"
          />
          AIStoryBound
        </NuxtLink>
      </template>

      <template #right>
        <UButton
          to="/worlds"
          icon="i-lucide-library"
          label="我的世界"
          color="neutral"
          variant="soft"
          size="sm"
        />

        <UColorModeButton />
      </template>
    </UHeader>

    <UMain>
      <NuxtPage />
    </UMain>

    <USeparator icon="i-simple-icons-nuxtdotjs" />

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">
          Built with Nuxt UI • © {{ new Date().getFullYear() }}
        </p>
      </template>

      <template #right>
        <UButton
          to="https://github.com/nuxt-ui-templates/starter"
          target="_blank"
          icon="i-simple-icons-github"
          aria-label="GitHub"
          color="neutral"
          variant="ghost"
        />
      </template>
    </UFooter>
  </UApp>
</template>