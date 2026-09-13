<script setup lang="ts">
// StorePluginsView.vue — 创意工坊「功能插件」商城:平台官方上架的硬件联动插件。
// 解锁消耗 token,点击「解锁」先弹确认模态框;已解锁不显示售价,按钮跳个人中心详细配置。
import type { StorePluginSummary } from '#shared/store-plugin'
import { useAuthSession } from '../utils/auth-client'

const toast = useToast()

const { data: session } = await useAuthSession()

const plugins = ref<StorePluginSummary[]>([])
const loading = ref(true)
const buying = ref(false)

async function load() {
  loading.value = true
  try {
    plugins.value = await $fetch<StorePluginSummary[]>('/api/store/plugins')
  } catch {
    plugins.value = []
  } finally {
    loading.value = false
  }
}

void load()

/** 待确认解锁的插件(null = 确认模态框关闭) */
const confirmPlugin = ref<StorePluginSummary | null>(null)

function askBuy(p: StorePluginSummary) {
  if (!session.value || buying.value) return
  confirmPlugin.value = p
}

async function buy() {
  const p = confirmPlugin.value
  if (!p || buying.value) return
  buying.value = true
  try {
    const res = await $fetch<{ ok: true, alreadyOwned?: boolean }>(`/api/store/plugins/${p.id}/purchase`, { method: 'POST' })
    if (res.alreadyOwned) {
      toast.add({ title: '已解锁', description: '该插件你已购买过,无需重复购买', color: 'neutral' })
    } else {
      toast.add({ title: '解锁成功', description: `「${p.name}」已解锁,可在个人中心 → 功能插件 详细配置`, color: 'success' })
    }
    confirmPlugin.value = null
    await load()
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, statusCode?: number }
    toast.add({
      title: '解锁失败',
      description: err.data?.statusMessage ?? (err.statusCode === 402 ? 'token 余额不足' : '请稍后重试'),
      color: 'error'
    })
  } finally {
    buying.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <div
      v-if="!session"
      class="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700"
    >
      登录后即可解锁功能插件
      <div
        class="mt-3"
      >
        <UButton
          to="/login"
          color="primary"
          size="sm"
        >
          去登录
        </UButton>
      </div>
    </div>

    <div
      v-if="loading"
      class="grid gap-3 md:grid-cols-2"
    >
      <USkeleton
        v-for="i in 2"
        :key="i"
        class="h-40"
      />
    </div>

    <div
      v-else-if="!plugins.length"
      class="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500 dark:border-neutral-700"
    >
      暂无功能插件,敬请期待
    </div>

    <div
      v-else
      class="grid gap-3 md:grid-cols-2"
    >
      <UCard
        v-for="p in plugins"
        :key="p.id"
        class="flex flex-col"
      >
        <div class="flex items-start gap-3">
          <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">
            {{ p.icon ?? '🧩' }}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-semibold">{{ p.name }}</span>
              <UBadge
                v-if="p.featured"
                size="xs"
                color="primary"
                variant="soft"
              >
                推荐
              </UBadge>
              <UBadge
                v-if="p.price === 0"
                size="xs"
                color="error"
                variant="soft"
              >
                限时免费
              </UBadge>
            </div>
            <p class="mt-1 line-clamp-3 text-sm text-neutral-500">
              {{ p.desc }}
            </p>
            <div class="mt-1 text-xs text-neutral-400">
              {{ p.purchaseCount }} 人已解锁
            </div>
          </div>
        </div>
        <div
          class="mt-3 flex items-center"
          :class="p.owned ? 'justify-end' : 'justify-between'"
        >
          <span
            v-if="!p.owned"
            class="text-sm font-semibold tabular-nums text-primary"
          >{{ p.price > 0 ? `${p.price.toLocaleString()} token` : '免费' }}</span>
          <UButton
            v-if="p.owned"
            size="sm"
            color="success"
            variant="soft"
            icon="i-lucide-check"
            to="/profile?tab=plugins"
          >
            已解锁 · 去配置
          </UButton>
          <UButton
            v-else
            size="sm"
            color="primary"
            icon="i-lucide-unlock"
            :disabled="!session"
            @click="askBuy(p)"
          >
            解锁
          </UButton>
        </div>
      </UCard>
    </div>

    <!-- 解锁确认:购买消耗 token,二次确认防误触 -->
    <UModal
      :open="confirmPlugin !== null"
      title="确认解锁插件"
      @update:open="!$event && (confirmPlugin = null)"
    >
      <template #body>
        <p v-if="confirmPlugin">
          确定花费
          <span class="font-semibold tabular-nums text-primary">{{ confirmPlugin.price.toLocaleString() }} token</span>
          解锁「{{ confirmPlugin.name }}」吗?
        </p>
        <p class="mt-2 text-xs text-neutral-400">
          解锁后可在个人中心 → 功能插件 中详细配置并连接设备;token 消耗不退还。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="soft"
            :disabled="buying"
            @click="confirmPlugin = null"
          >
            取消
          </UButton>
          <UButton
            color="primary"
            icon="i-lucide-unlock"
            :loading="buying"
            @click="buy"
          >
            确认解锁
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
