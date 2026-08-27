<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

// /admin 管理后台专用布局:左侧可折叠侧边栏(仪表盘 / 兑换码 / 充值记录 / Skill 审核)+ 内容区。
// 不套 default.vue 的全站导航与页脚;页面级鉴权由各页 definePageMeta middleware: 'admin' 负责。
const open = ref(true)
const route = useRoute()

const items = computed<NavigationMenuItem[]>(() => [
  { label: '仪表盘', icon: 'i-lucide-layout-dashboard', to: '/admin', active: route.path === '/admin' },
  { label: '兑换码管理', icon: 'i-lucide-ticket', to: '/admin/redeem', active: route.path === '/admin/redeem' },
  { label: '充值记录', icon: 'i-lucide-credit-card', to: '/admin/recharge', active: route.path === '/admin/recharge' },
  { label: 'Skill 审核', icon: 'i-lucide-shield-check', to: '/admin/skills', active: route.path === '/admin/skills' },
  { label: '小说审核', icon: 'i-lucide-book-open', to: '/admin/novels', active: route.path === '/admin/novels' },
  { label: '需求管理', icon: 'i-lucide-list-checks', to: '/admin/requests', active: route.path === '/admin/requests' }
])
</script>

<template>
  <div class="flex h-dvh">
    <USidebar
      v-model:open="open"
      collapsible="icon"
      :ui="{
        container: 'h-full',
        body: 'py-2'
      }"
    >
      <template #header>
        <NuxtLink
          to="/"
          class="flex min-w-0 items-center gap-1.5 px-2 font-bold tracking-tight text-highlighted"
        >
          <img
            src="/pwa/pwa-192x192.png"
            alt="AI Word2World"
            class="size-5 shrink-0"
            draggable="false"
          >
          <span class="truncate">管理后台</span>
        </NuxtLink>
      </template>

      <UNavigationMenu
        :items="items"
        orientation="vertical"
        :ui="{ link: 'p-1.5 overflow-hidden' }"
      />

      <template #footer>
        <NuxtLink
          to="/"
          class="flex items-center gap-1.5 px-2 py-1.5 text-sm text-neutral-500 hover:text-primary"
        >
          <UIcon
            name="i-lucide-arrow-left"
            class="size-4"
          />
          <span>返回主站</span>
        </NuxtLink>
      </template>
    </USidebar>

    <div class="flex min-w-0 flex-1 flex-col">
      <div class="h-(--ui-header-height) shrink-0 flex items-center justify-between border-b border-default px-4">
        <UButton
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          aria-label="切换侧边栏"
          @click="open = !open"
        />
        <NuxtLink
          to="/"
          class="text-sm text-neutral-500 transition-colors hover:text-primary"
        >
          返回主站
        </NuxtLink>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <slot />
      </div>
    </div>
  </div>
</template>
