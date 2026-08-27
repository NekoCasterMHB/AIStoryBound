<script setup lang="ts">
// /workshop — 创意工坊:书架(小说商城)/ Skill包(原 Skill 商城)/ 功能插件(开发中)。
// 支持 ?tab=novels|skills|plugins 深链(如 /workshop?tab=skills)。
useHead({ title: 'AI Word2World · 创意工坊' })

const route = useRoute()
const router = useRouter()

const workshopTabs = [
  { label: '书架', value: 'novels', slot: 'novels', icon: 'i-lucide-book-open' },
  { label: 'Skill包', value: 'skills', slot: 'skills', icon: 'i-lucide-package' },
  { label: '功能插件', value: 'plugins', slot: 'plugins', icon: 'i-lucide-plug' }
] as const

const tab = ref<string>(
  typeof route.query.tab === 'string' && workshopTabs.some(t => t.value === route.query.tab)
    ? route.query.tab
    : 'novels'
)

/** 切换 tab 时同步 query,保证深链/刷新后停留在当前板块 */
function onTabChange(v: string | number) {
  const key = String(v)
  tab.value = key
  void router.replace({ query: { ...route.query, tab: key } })
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-6">
      <h1 class="flex items-center gap-2 text-xl font-semibold">
        <UIcon
          name="i-lucide-gem"
          class="size-5 text-primary"
        />
        创意工坊
      </h1>
      <p class="mt-1 text-sm text-neutral-500">
        社区创作的集中地:书架买卖小说、Skill包买卖玩法技能,功能插件即将开放
      </p>
    </div>

    <UTabs
      :model-value="tab"
      variant="pill"
      color="primary"
      :items="workshopTabs.map(t => ({ label: t.label, value: t.value, slot: t.slot, icon: t.icon }))"
      class="mb-6"
      @update:model-value="onTabChange"
    >
      <!-- 书架:小说商城(购买/发布/审核流程同 Skill 商城) -->
      <template #novels>
        <NovelStoreView />
      </template>

      <!-- Skill包:原 Skill 商城迁入 -->
      <template #skills>
        <StoreSkillsView />
      </template>

      <!-- 功能插件:开发中占位 -->
      <template #plugins>
        <UCard>
          <div class="flex flex-col items-center gap-3 py-14 text-center">
            <div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
              <UIcon
                name="i-lucide-plug-zap"
                class="size-8 text-primary"
              />
            </div>
            <p class="text-lg font-semibold">
              功能插件 · 开发中
            </p>
            <p class="max-w-md text-sm leading-relaxed text-neutral-500">
              功能插件将赋予 AI 操作外部设备的能力(小玩具联动等 你懂的对吧~),
              让游玩体验突破屏幕。敬请期待,欢迎在需求墙提出你想要的联动功能。
            </p>
            <div class="mt-2 flex items-center gap-3">
              <UButton
                to="/demand"
                color="primary"
                variant="soft"
                icon="i-lucide-lightbulb"
              >
                去需求墙提建议
              </UButton>
              <UBadge
                color="neutral"
                variant="outline"
                size="lg"
              >
                敬请期待
              </UBadge>
            </div>
          </div>
        </UCard>
      </template>
    </UTabs>
  </div>
</template>
