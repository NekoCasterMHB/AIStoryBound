<script setup>
// 默认布局:全局导航栏 + 主内容 + 页脚 + 登录模态框(原 app.vue 结构)。沉浸式阅读页走 layouts/reader.vue,不经过本布局。
import { useAuthModal } from '~/composables/useAuthModal'
import { authClient, useAuthSession } from '~/utils/auth-client'

// 全局导航栏右侧:生成世界入口 + 登录(未登录)/用户菜单(已登录)
const { data: session } = await useAuthSession()
const user = computed(() => session.value?.user)
const { requireLogin } = useAuthModal()

async function onStartGenerate() {
  const ok = await requireLogin()
  if (ok) navigateTo('/generate')
}

async function onLoginClick() {
  const ok = await requireLogin()
  // 已登录则直接进入我的书架
  if (ok) navigateTo('/works')
}

async function onLogout() {
  await authClient.signOut()
  navigateTo('/')
}
</script>

<template>
  <div>
    <!-- :toggle="false" 去掉移动端最右侧的侧边栏展开按钮(本布局未提供侧边栏内容) -->
    <!-- 窄屏压缩:right 组件间距收紧,书架/商城在窄屏仅显示图标,避免按钮群横向溢出 -->
    <UHeader
      :toggle="false"
      :ui="{
        right: 'gap-1 lg:gap-1.5'
      }"
    >
      <template #left>
        <NuxtLink
          to="/"
          class="flex min-w-0 items-center gap-1.5 text-sm font-bold tracking-tight text-highlighted sm:text-lg"
        >
          <img
            src="/pwa/pwa-192x192.png"
            alt="AI Word2World"
            class="size-10 shrink-0"
            draggable="false"
          >
          <!-- 极窄屏(≤340px,老 iPhone SE/小屏安卓)仅保留图标,避免挤压右侧按钮组 -->
          <span class="hidden min-[341px]:inline">AI Word2World</span>
        </NuxtLink>
      </template>

      <template #right>
        <!-- 主题色切换(主色/中性色),选择持久化到 localStorage -->
        <ThemeColorPopover />

        <UColorModeButton />

        <!-- 书架/商城入口:窄屏(<lg)仅显示图标,保留入口;桌面显示图标+文字 -->
        <div class="lg:hidden">
          <UButton
            to="/works"
            icon="i-lucide-library"
            color="neutral"
            variant="soft"
            size="sm"
            square
            aria-label="我的书架"
          />
        </div>
        <div class="hidden lg:block">
          <UButton
            to="/works"
            icon="i-lucide-library"
            color="neutral"
            variant="soft"
            size="sm"
            aria-label="我的书架"
          >
            <span>我的书架</span>
          </UButton>
        </div>

        <div class="lg:hidden">
          <UButton
            to="/store"
            icon="i-lucide-store"
            variant="subtle"
            size="sm"
            square
            aria-label="Skill商城"
          />
        </div>
        <div class="hidden lg:block">
          <UButton
            to="/store"
            icon="i-lucide-store"
            variant="subtle"
            size="sm"
            aria-label="Skill商城"
          >
            <span>Skill商城</span>
          </UButton>
        </div>

        <UButton
          color="primary"
          icon="i-lucide-sparkles"
          size="sm"
          aria-label="生成世界"
          @click="onStartGenerate"
        >
          <span class="hidden sm:inline">生成世界</span>
        </UButton>

        <template v-if="!user">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-log-in"
            size="sm"
            @click="onLoginClick"
          >
            登录
          </UButton>
        </template>
        <template v-else>
          <UDropdownMenu
            :items="[
              [{ label: `你好, ${user.name || ''}`, disabled: true }],
              [{ label: '个人中心', icon: 'i-lucide-user-round', onSelect: () => navigateTo('/profile') }],
              [{ label: '我的书架', icon: 'i-lucide-library-big', onSelect: () => navigateTo('/works') }],
              [{ label: '退出登录', icon: 'i-lucide-log-out', onSelect: onLogout }]
            ]"
          >
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-user-round"
              size="sm"
              aria-label="用户菜单"
            />
          </UDropdownMenu>
        </template>
      </template>
    </UHeader>

    <UMain>
      <slot />
    </UMain>

    <!-- 全站页脚(阅读页走 reader 布局,不经过本布局) -->
    <!-- 左右两栏平衡:品牌在左、链接在右;移动端用 order 保证品牌在前 -->
    <UFooter
      class="border-t border-neutral-200 dark:border-neutral-800"
      :ui="{
        container: 'flex flex-col py-8 lg:py-4 lg:flex-row lg:items-center lg:justify-between lg:gap-x-3',
        left: 'order-1 flex items-center justify-center lg:justify-start lg:flex-1 gap-x-1.5 mt-3 lg:mt-0',
        center: 'hidden',
        right: 'order-2 flex items-center justify-center lg:justify-end lg:flex-1 gap-x-1.5 mt-8 lg:mt-0',
      }"
    >
      <template #left>
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-1.5 text-base font-bold tracking-tight text-highlighted">
            <img
              src="/pwa/pwa-192x192.png"
              alt="AI Word2World"
              class="size-5 shrink-0"
              draggable="false"
            >
            AI Word2World
          </div>
          <p class="max-w-xs text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            把每一本小说,变成真实可互动的世界。
          </p>
        </div>
      </template>

      <template #right>
        <!-- 开始使用 / 了解我们:sp 端以下也保持两列并排,仅收窄间距;窄屏整体居中 -->
        <div class="flex w-full flex-row justify-center gap-8 sm:w-auto sm:gap-16">
          <div>
            <p class="mb-3 text-xs font-semibold tracking-wider text-neutral-400 dark:text-neutral-500">
              开始使用
            </p>
            <ul class="space-y-2 text-sm">
              <li>
                <NuxtLink
                  to="/generate"
                  class="text-neutral-600 transition-colors hover:text-primary dark:text-neutral-400 dark:hover:text-primary-400"
                >
                  生成世界
                </NuxtLink>
              </li>
              <li>
                <NuxtLink
                  to="/works"
                  class="text-neutral-600 transition-colors hover:text-primary dark:text-neutral-400 dark:hover:text-primary-400"
                >
                  我的书架
                </NuxtLink>
              </li>
              <li>
                <NuxtLink
                  to="/profile"
                  class="text-neutral-600 transition-colors hover:text-primary dark:text-neutral-400 dark:hover:text-primary-400"
                >
                  个人中心
                </NuxtLink>
              </li>
              <li>
                <NuxtLink
                  to="/store"
                  class="text-neutral-600 transition-colors hover:text-primary dark:text-neutral-400 dark:hover:text-primary-400"
                >
                  Skill商城
                </NuxtLink>
              </li>
              <li>
                <NuxtLink
                  to="/demand"
                  class="text-neutral-600 transition-colors hover:text-primary dark:text-neutral-400 dark:hover:text-primary-400"
                >
                  需求墙
                </NuxtLink>
              </li>
            </ul>
          </div>
          <div>
            <p class="mb-3 text-xs font-semibold tracking-wider text-neutral-400 dark:text-neutral-500">
              了解我们
            </p>
            <ul class="space-y-2 text-sm">
              <li>
                <NuxtLink
                  to="/#how"
                  class="text-neutral-600 transition-colors hover:text-primary dark:text-neutral-400 dark:hover:text-primary-400"
                >
                  玩法介绍
                </NuxtLink>
              </li>
              <li>
                <NuxtLink
                  to="/#faq"
                  class="text-neutral-600 transition-colors hover:text-primary dark:text-neutral-400 dark:hover:text-primary-400"
                >
                  常见问题
                </NuxtLink>
              </li>
            </ul>
          </div>
        </div>
      </template>

      <template #bottom>
        <UContainer>
          <p class="border-t border-neutral-200 pt-8 text-center text-xs text-neutral-500 lg:pt-12 dark:border-neutral-800 dark:text-neutral-400">
            © 2026 AI Word2World · 
          </p>
        </UContainer>
      </template>
    </UFooter>

    <!-- 全局登录模态框(导航栏"登录/生成世界"入口弹出) -->
    <AuthModal />
  </div>
</template>
