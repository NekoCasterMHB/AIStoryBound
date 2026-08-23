<script setup lang="ts">
// /login — 登录/注册(直接访问时兜底):进入页面即打开全局 AuthModal(app.vue 唯一实例);
// 已登录访问 → 不弹框直接回跳 redirect;未登录 → 弹框,登录成功或关闭后均回跳。
import { useAuthModal } from '~/composables/useAuthModal'

useHead({ title: 'AI StoryBound · 登录' })

const route = useRoute()
const redirect = computed(() => (typeof route.query.redirect === 'string' ? route.query.redirect : '/'))

const { requireLogin } = useAuthModal()

onMounted(async () => {
  // requireLogin 内部先查会话:已登录直接返回 true(不弹框)
  const ok = await requireLogin()
  navigateTo(ok ? redirect.value : '/')
})

// 监听会话:登录成功后跳回 redirect
const { data: session } = await useAuthSession()
watch(session, (s) => {
  if (s?.user) navigateTo(redirect.value)
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-4 bg-neutral-950">
    <div class="text-center">
      <div class="text-5xl mb-3">
        📖
      </div>
      <h1 class="text-2xl font-bold text-white">
        AI StoryBound
      </h1>
      <p class="text-sm text-neutral-400 mt-1">
        登录后开始你的故事
      </p>
    </div>
  </div>
</template>
