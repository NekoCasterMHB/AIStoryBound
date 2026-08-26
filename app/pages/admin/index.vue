<script setup lang="ts">
import { useAuthSession } from '../../utils/auth-client'

// /admin — 管理仪表盘(管理后台首页;管理员校验前置到路由中间件
// middleware/admin.ts,非管理员在进入页面前就被重定向回首页;接口层 requireAdmin 二次鉴权兜底)
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 管理仪表盘' })

const { data: session } = await useAuthSession()
const toast = useToast()

interface DashboardData {
  users: { total: number, day24: number }
  tokens: { totalConsumed: number, day24Consumed: number }
  deepseek: {
    available: boolean
    balanceInfos: { currency: string, totalBalance: string, grantedBalance: string, toppedUpBalance: string }[]
    error?: string
  } | null
}

const isAdmin = ref(false)
const loading = ref(true)
const data = ref<DashboardData | null>(null)
const refreshing = ref(false)

async function load() {
  refreshing.value = true
  try {
    data.value = await $fetch<DashboardData>('/api/admin/dashboard')
    isAdmin.value = true
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    if (status === 401 || status === 403) {
      toast.add({
        title: status === 401 ? '请先登录' : '当前账号无管理权限',
        description: '正在为你跳转到首页…',
        color: 'error'
      })
      await navigateTo('/')
    } else {
      isAdmin.value = true
      toast.add({ title: '加载仪表盘失败,请刷新重试', color: 'error' })
    }
  } finally {
    loading.value = false
    refreshing.value = false
  }
}
onMounted(() => { void load() })

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const cards = computed(() => {
  const d = data.value
  return [
    { label: '总注册用户', value: d ? d.users.total.toLocaleString() : '—', icon: 'i-lucide-users', cls: 'text-primary' },
    { label: '近 24h 注册', value: d ? d.users.day24.toLocaleString() : '—', icon: 'i-lucide-user-plus', cls: 'text-emerald-600' },
    { label: '总消耗 token', value: d ? fmtTokens(d.tokens.totalConsumed) : '—', icon: 'i-lucide-flame', cls: 'text-amber-600' },
    { label: '近 24h 消耗', value: d ? fmtTokens(d.tokens.day24Consumed) : '—', icon: 'i-lucide-activity', cls: 'text-rose-500' }
  ]
})
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          管理仪表盘
        </h1>
        <p class="text-sm text-neutral-500">
          {{ session?.user?.email || '—' }} · 平台运营概览
        </p>
      </div>
      <UButton
        color="neutral"
        variant="soft"
        icon="i-lucide-refresh-cw"
        :loading="refreshing"
        @click="load"
      >
        刷新
      </UButton>
    </div>

    <div v-if="!isAdmin" class="py-10 text-center text-sm text-neutral-500">
      正在校验管理权限…
    </div>

    <template v-else>
      <!-- 统计卡片 -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <UCard
          v-for="c in cards"
          :key="c.label"
        >
          <div class="flex items-center gap-3">
            <div
              class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-900"
            >
              <UIcon
                :name="c.icon"
                class="size-5"
                :class="c.cls"
              />
            </div>
            <div class="min-w-0">
              <p class="text-xs text-neutral-500">
                {{ c.label }}
              </p>
              <p class="truncate text-xl font-bold tabular-nums">
                {{ c.value }}
              </p>
            </div>
          </div>
        </UCard>
      </div>

      <!-- DeepSeek 账户余额 -->
      <UCard class="mt-4">
        <div class="mb-3 flex items-center justify-between gap-3">
          <p class="flex items-center gap-2 font-semibold">
            <UIcon
              name="i-simple-icons-openai"
              class="size-4 text-emerald-600"
            />
            DeepSeek 账户余额
          </p>
          <UBadge
            size="sm"
            :color="data?.deepseek?.available ? 'success' : 'error'"
            variant="soft"
          >
            {{ data?.deepseek?.available ? '可用' : '不可用' }}
          </UBadge>
        </div>
        <div v-if="loading" class="py-6 text-center text-sm text-neutral-500">
          加载中…
        </div>
        <template v-else-if="data?.deepseek">
          <div
            v-if="data.deepseek.balanceInfos.length"
            class="grid gap-3 sm:grid-cols-3"
          >
            <div
              v-for="b in data.deepseek.balanceInfos"
              :key="b.currency"
              class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <p class="text-xs text-neutral-500">
                {{ b.currency }} 总余额
              </p>
              <p class="text-lg font-bold tabular-nums">
                ¥{{ b.totalBalance }}
              </p>
              <p class="mt-1 text-xs text-neutral-500">
                充值余额 ¥{{ b.toppedUpBalance }} · 赠送余额 ¥{{ b.grantedBalance }}
              </p>
            </div>
          </div>
          <p
            v-else
            class="text-sm text-red-500"
          >
            余额查询失败:{{ data.deepseek.error || '未知错误' }}
          </p>
        </template>
        <p v-else class="text-sm text-neutral-500">
          加载中…
        </p>
      </UCard>

      <p class="mt-3 text-xs text-neutral-400">
        * 总消耗 = 注册赠送 + 已支付订单发放 − 当前全站余额(含全部历史,精确);近 24h 消耗自用量记录表(ai_usage)部署起累计。
      </p>
    </template>
  </div>
</template>
