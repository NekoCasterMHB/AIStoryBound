<script setup lang="ts">
import { useAuthSession } from '../../utils/auth-client'

// /admin — 管理仪表盘(管理后台首页;管理员校验前置到路由中间件
// middleware/admin.ts,非管理员在进入页面前就被重定向回首页;接口层 requireAdmin 二次鉴权兜底)
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 管理仪表盘' })

const { data: session } = await useAuthSession()
const toast = useToast()

interface AccountBalance {
  label: string
  source: 'db' | 'env'
  provider: 'deepseek' | 'muskapi' | 'openrouter' | 'unknown'
  supported: boolean
  available: boolean
  active: boolean
  model: string | null
  balanceInfos?: { currency: string, totalBalance: string, grantedBalance: string, toppedUpBalance: string }[]
  musk?: { balance: number | null, remaining: number | null, unit: string, isValid: boolean, mode: string | null, totalCost: number | null }
  openrouter?: { totalCredits: number | null, totalUsage: number | null, remaining: number | null, limit: number | null, isFreeTier: boolean | null, unit: string }
  error?: string
}

interface DashboardData {
  users: { total: number, day24: number }
  revenue: { total: number, day24: number }
  tokens: { totalConsumed: number, day24Consumed: number }
  pending: { skills: number, novels: number, requests: number }
  accounts: AccountBalance[]
  aiConfig: {
    name: string | null
    source: 'db' | 'env'
    model: string
    baseUrl: string
    activeCount: number
    totalCount: number
    routing: { worldGen: string | null, chat: string | null }
  }
  /** 充值是否处于维护(关闭)状态:false=开放可充值,true=维护中 */
  paymentDisabled: boolean
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
onMounted(() => {
  void load()
})

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 分 → ¥ 元 */
function fmtCny(fen: number) {
  return `¥${(fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const cards = computed(() => {
  const d = data.value
  return [
    { label: '总充值收入', value: d ? fmtCny(d.revenue.total) : '—', icon: 'i-lucide-wallet', cls: 'text-emerald-600' },
    { label: '近 24h 充值', value: d ? fmtCny(d.revenue.day24) : '—', icon: 'i-lucide-circle-dollar-sign', cls: 'text-emerald-500' },
    { label: '总注册用户', value: d ? d.users.total.toLocaleString() : '—', icon: 'i-lucide-users', cls: 'text-primary' },
    { label: '近 24h 注册', value: d ? d.users.day24.toLocaleString() : '—', icon: 'i-lucide-user-plus', cls: 'text-sky-600' },
    { label: '总消耗 token', value: d ? fmtTokens(d.tokens.totalConsumed) : '—', icon: 'i-lucide-flame', cls: 'text-amber-600' },
    { label: '近 24h 消耗', value: d ? fmtTokens(d.tokens.day24Consumed) : '—', icon: 'i-lucide-activity', cls: 'text-rose-500' }
  ]
})

/** 待审核处理入口(数量 >0 高亮) */
const pendingItems = computed(() => {
  const p = data.value?.pending
  return [
    { label: 'Skill 待审', count: p?.skills ?? 0, to: '/admin/skills', icon: 'i-lucide-store' },
    { label: '小说待审', count: p?.novels ?? 0, to: '/admin/novels', icon: 'i-lucide-book-open' },
    { label: '待处理需求', count: p?.requests ?? 0, to: '/admin/requests', icon: 'i-lucide-inbox' }
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

    <div
      v-if="!isAdmin"
      class="py-10 text-center text-sm text-neutral-500"
    >
      正在校验管理权限…
    </div>

    <template v-else>
      <!-- 统计卡片 -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

      <!-- 待审核处理 -->
      <UCard class="mt-4">
        <div class="mb-3 flex items-center gap-2">
          <UIcon
            name="i-lucide-clipboard-check"
            class="size-4 text-amber-600"
          />
          <p class="font-semibold">
            待审核处理
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <NuxtLink
            v-for="item in pendingItems"
            :key="item.label"
            :to="item.to"
            class="flex items-center gap-3 rounded-lg border p-3 transition-colors"
            :class="item.count > 0
              ? 'border-red-200 bg-red-50 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:hover:bg-red-950'
              : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'"
          >
            <UIcon
              :name="item.icon"
              class="size-5 shrink-0"
              :class="item.count > 0 ? 'text-red-500' : 'text-neutral-400'"
            />
            <div class="min-w-0 flex-1">
              <p
                class="truncate text-sm font-medium"
                :class="item.count > 0 ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-300'"
              >
                {{ item.label }}
              </p>
              <p class="text-xs text-neutral-500">
                {{ item.count > 0 ? `${item.count} 条待处理` : '暂无待处理' }}
              </p>
            </div>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 shrink-0 text-neutral-400"
            />
          </NuxtLink>
        </div>
      </UCard>

      <!-- 充值开放状态(每小时健康检查自动切换 / 管理端手动设置) -->
      <UCard class="mt-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p class="flex items-center gap-2 font-semibold">
            <UIcon
              name="i-lucide-wallet"
              class="size-4 text-emerald-600"
            />
            充值开放状态
          </p>
          <UBadge
            v-if="!loading"
            size="sm"
            :color="data?.paymentDisabled ? 'error' : 'success'"
            variant="soft"
          >
            {{ data?.paymentDisabled ? '充值维护中' : '充值开放' }}
          </UBadge>
        </div>
        <div
          v-if="loading"
          class="py-6 text-center text-sm text-neutral-500"
        >
          加载中…
        </div>
        <div
          v-else-if="data"
          class="flex flex-wrap items-center justify-between gap-3"
        >
          <p class="text-sm text-neutral-600 dark:text-neutral-300">
            {{ data.paymentDisabled
              ? '用户端充值下单已关闭(兑换码通道不受影响),由每小时健康检查在网关恢复后自动开启'
              : '用户可正常下单充值;每小时健康检查会在网关异常时自动切换为维护' }}
          </p>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-settings-2"
            to="/admin/recharge"
          >
            充值管理
          </UButton>
        </div>
      </UCard>

      <!-- AI 配置生效状态 -->
      <UCard class="mt-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p class="flex items-center gap-2 font-semibold">
            <UIcon
              name="i-lucide-cpu"
              class="size-4 text-violet-600"
            />
            AI 配置生效状态
          </p>
          <div class="flex items-center gap-2">
            <UBadge
              size="sm"
              :color="data?.aiConfig.source === 'db' ? 'primary' : 'warning'"
              variant="soft"
            >
              {{ data?.aiConfig.source === 'db' ? '后台配置' : '环境变量' }}
            </UBadge>
            <UBadge
              size="sm"
              color="neutral"
              variant="soft"
            >
              启用 {{ data?.aiConfig.activeCount ?? 0 }} / 共 {{ data?.aiConfig.totalCount ?? 0 }} 条
            </UBadge>
          </div>
        </div>
        <div
          v-if="loading"
          class="py-6 text-center text-sm text-neutral-500"
        >
          加载中…
        </div>
        <div
          v-else-if="data"
          class="grid gap-3 sm:grid-cols-2"
        >
          <div class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <p class="text-xs text-neutral-500">
              当前生效配置
            </p>
            <p class="truncate font-semibold">
              {{ data.aiConfig.source === 'db' ? data.aiConfig.name ?? '未命名' : '环境变量兜底' }}
            </p>
            <p class="mt-1 truncate text-xs text-neutral-500">
              模型 {{ data.aiConfig.model }} · {{ data.aiConfig.baseUrl }}
            </p>
          </div>
          <div class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <p class="text-xs text-neutral-500">
              用途模型路由
            </p>
            <p class="mt-1 text-sm">
              <span class="text-neutral-500">世界生成:</span>
              <span class="font-medium">{{ data.aiConfig.routing.worldGen ?? '跟随生效配置' }}</span>
            </p>
            <p class="text-sm">
              <span class="text-neutral-500">对话类:</span>
              <span class="font-medium">{{ data.aiConfig.routing.chat ?? '跟随生效配置' }}</span>
            </p>
          </div>
        </div>
      </UCard>

      <!-- AI 账户余额(逐配置展示;不支持的查询平台显示「不支持」) -->
      <UCard class="mt-4">
        <div class="mb-3 flex items-center gap-2">
          <UIcon
            name="i-lucide-landmark"
            class="size-4 text-emerald-600"
          />
          <p class="font-semibold">
            AI 账户余额
          </p>
          <span class="text-xs text-neutral-400">
            扫描全部已保存配置(含未启用),按平台支持情况查询
          </span>
        </div>
        <div
          v-if="loading"
          class="py-6 text-center text-sm text-neutral-500"
        >
          加载中…
        </div>
        <p
          v-else-if="!data?.accounts.length"
          class="text-sm text-neutral-500"
        >
          暂无已保存的 AI 配置
        </p>
        <div
          v-else
          class="flex flex-col gap-3"
        >
          <div
            v-for="acc in data.accounts"
            :key="`${acc.source}-${acc.label}`"
            class="rounded-lg border p-3"
            :class="acc.supported ? 'border-neutral-200 dark:border-neutral-800' : 'border-dashed border-neutral-200 dark:border-neutral-800'"
          >
            <div class="flex flex-wrap items-center gap-2">
              <p class="font-medium">
                {{ acc.label }}
              </p>
              <UBadge
                size="sm"
                color="neutral"
                variant="subtle"
              >
                {{ acc.source === 'db' ? '后台' : '环境变量' }}
              </UBadge>
              <UBadge
                v-if="!acc.supported"
                size="sm"
                color="neutral"
                variant="soft"
              >
                不支持余额查询
              </UBadge>
              <UBadge
                v-else
                size="sm"
                :color="acc.available ? 'success' : 'error'"
                variant="soft"
              >
                {{ acc.available ? '可用' : '不可用' }}
              </UBadge>
              <UBadge
                v-if="acc.source === 'db' && acc.active"
                size="sm"
                color="primary"
                variant="subtle"
              >
                启用中
              </UBadge>
              <span
                v-if="acc.model"
                class="truncate text-xs text-neutral-400"
              >
                {{ acc.model }}
              </span>
            </div>

            <!-- 不支持的平台:不显示余额区 -->
            <p
              v-if="!acc.supported"
              class="mt-2 text-xs text-neutral-400"
            >
              该平台暂不支持余额查询,可在对应服务商控制台查看
            </p>
            <template v-else>
              <p
                v-if="acc.error && !acc.balanceInfos?.length && !acc.musk && !acc.openrouter"
                class="mt-2 text-sm text-red-500"
              >
                余额查询失败:{{ acc.error }}
              </p>
              <!-- DeepSeek -->
              <template v-else-if="acc.balanceInfos?.length">
                <div
                  v-for="b in acc.balanceInfos"
                  :key="b.currency"
                  class="mt-2"
                >
                  <p class="text-lg font-bold tabular-nums">
                    ¥{{ b.totalBalance }}
                    <span class="text-xs font-normal text-neutral-500">{{ b.currency }}</span>
                  </p>
                  <p class="text-xs text-neutral-500">
                    充值余额 ¥{{ b.toppedUpBalance }} · 赠送余额 ¥{{ b.grantedBalance }}
                  </p>
                </div>
              </template>
              <!-- MuskAPI -->
              <p
                v-else-if="acc.musk"
                class="mt-2"
              >
                <span class="text-lg font-bold tabular-nums">
                  {{ acc.musk.balance ?? '—' }}
                  <span class="text-xs font-normal text-neutral-500">{{ acc.musk.unit }}</span>
                </span>
                <span
                  v-if="acc.musk.remaining !== null && acc.musk.mode === 'quota_limited'"
                  class="ml-2 text-xs text-neutral-500"
                >
                  Key 剩余 {{ acc.musk.remaining }} {{ acc.musk.unit }}
                </span>
                <span
                  v-if="acc.musk.totalCost !== null"
                  class="ml-2 text-xs text-neutral-500"
                >
                  累计消费 {{ acc.musk.totalCost }} {{ acc.musk.unit }}
                </span>
              </p>
              <!-- OpenRouter -->
              <template v-else-if="acc.openrouter">
                <p class="mt-2">
                  <span class="text-lg font-bold tabular-nums">
                    ${{ acc.openrouter.remaining?.toFixed(2) ?? '—' }}
                    <span class="text-xs font-normal text-neutral-500">剩余({{ acc.openrouter.unit }})</span>
                  </span>
                  <span
                    v-if="acc.openrouter.totalCredits !== null"
                    class="ml-2 text-xs text-neutral-500"
                  >
                    已购 ${{ acc.openrouter.totalCredits.toFixed(2) }}
                  </span>
                  <span
                    v-if="acc.openrouter.totalUsage !== null"
                    class="ml-2 text-xs text-neutral-500"
                  >
                    已用 ${{ acc.openrouter.totalUsage.toFixed(2) }}
                  </span>
                </p>
                <p
                  v-if="acc.openrouter.isFreeTier !== null || acc.openrouter.limit !== null"
                  class="mt-1 text-xs text-neutral-500"
                >
                  <span v-if="acc.openrouter.isFreeTier">免费档 · </span>
                  <span v-if="acc.openrouter.limit !== null">Key 额度上限 ${{ acc.openrouter.limit.toFixed(2) }}</span>
                  <span v-else>Key 不限额度(pay-as-you-go)</span>
                </p>
              </template>
            </template>
          </div>
        </div>
      </UCard>

      <p class="mt-3 text-xs text-neutral-400">
        * 总消耗 = 注册赠送 + 已支付订单发放 + 兑换码发放 − 商城手续费 − 当前全站余额(存量恒等式,含全部历史,精确);近 24h 消耗自用量记录表(ai_usage)部署起累计;充值收入为已支付订单实付金额。
      </p>
    </template>
  </div>
</template>
