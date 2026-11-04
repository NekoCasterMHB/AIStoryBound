<script setup lang="ts">
// /admin/recharge — 充值记录(管理后台):全量 token 加油包订单审计,支持状态筛选与分页。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 充值记录' })

const toast = useToast()

interface RechargeRow {
  id: string
  orderNo: string
  userId: string
  userName: string | null
  userEmail: string | null
  packageId: string
  packageName: string
  /** 分 */
  amount: number
  currency: string
  provider: string
  providerTradeNo: string | null
  status: string
  paidAt: number | null
  createdAt: number
}

const ORDER_STATUS: Record<string, { text: string, cls: string }> = {
  pending: { text: '待支付', cls: 'text-amber-600' },
  paid: { text: '已支付', cls: 'text-emerald-600' },
  closed: { text: '已关闭', cls: 'text-neutral-400' },
  refunded: { text: '已退款', cls: 'text-red-500' }
}
const PROVIDER_LABELS: Record<string, string> = {
  wxpay: '微信支付',
  alipay: '支付宝',
  unknown: '未知'
}

const rows = ref<RechargeRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 10
const stats = ref<{ status: string, n: number }[]>([])
/** 收入统计(分):总收入/近30天/近24小时 */
const revenue = ref<{ total: number, day30: number, day24: number }>({ total: 0, day30: 0, day24: 0 })
const loading = ref(false)
const statusFilter = ref('')

async function load(pageNum = page.value) {
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(pageNum), pageSize: String(pageSize) })
    if (statusFilter.value) query.set('status', statusFilter.value)
    const res = await $fetch<{ rows: RechargeRow[], total: number, stats: { status: string, n: number }[], revenue: { total: number, day30: number, day24: number } }>(
      `/api/admin/recharge/list?${query}`
    )
    rows.value = res.rows
    total.value = res.total
    stats.value = res.stats
    revenue.value = res.revenue
    page.value = pageNum
  } catch (e) {
    toast.add({ title: '加载充值记录失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load(1)
})

/** 分 → 元 */
function fmtYuan(fen: number) {
  return (fen / 100).toFixed(2)
}

// ---- 支付渠道开关(存 app_config 表,按渠道单独启停,即时生效,无需重新部署) ----
// 两渠道都关闭时用户端即视为全局维护(健康检查自动维护写全局 key,对所有渠道生效)。
const wxpayDisabled = ref(false)
const alipayDisabled = ref(false)
/** 渠道单独禁用的原因(管理员手动关闭时记录) */
const wxpayReason = ref('')
const alipayReason = ref('')
/** 健康检查自动维护的原因(全局 key) */
const maintenanceReason = ref('')
const configBusy = ref<'wxpay' | 'alipay' | null>(null)

async function loadConfig() {
  const cfg = await $fetch<{
    paymentDisabled: boolean, reason?: string,
    wxpayDisabled: boolean, alipayDisabled: boolean,
    channelReasons: { wxpay?: string, alipay?: string }
  }>('/api/payment/config').catch(() => null)
  wxpayDisabled.value = cfg?.wxpayDisabled ?? false
  alipayDisabled.value = cfg?.alipayDisabled ?? false
  wxpayReason.value = cfg?.channelReasons?.wxpay ?? ''
  alipayReason.value = cfg?.channelReasons?.alipay ?? ''
  maintenanceReason.value = cfg?.reason ?? ''
}

async function toggleChannel(channel: 'wxpay' | 'alipay') {
  if (configBusy.value) return
  configBusy.value = channel
  try {
    const body = channel === 'wxpay'
      ? { wxpayDisabled: !wxpayDisabled.value }
      : { alipayDisabled: !alipayDisabled.value }
    const res = await $fetch<{ wxpayDisabled: boolean, alipayDisabled: boolean }>('/api/admin/recharge/config', {
      method: 'PUT',
      body
    })
    wxpayDisabled.value = res.wxpayDisabled
    alipayDisabled.value = res.alipayDisabled
    if (channel === 'wxpay') wxpayReason.value = res.wxpayDisabled ? '管理员手动关闭' : ''
    else alipayReason.value = res.alipayDisabled ? '管理员手动关闭' : ''
    toast.add({
      title: channel === 'wxpay'
        ? (res.wxpayDisabled ? '已禁用微信支付' : '已开启微信支付')
        : (res.alipayDisabled ? '已禁用支付宝' : '已开启支付宝'),
      description: res.wxpayDisabled && res.alipayDisabled ? '两渠道均已关闭,用户端充值入口进入维护状态' : undefined,
      color: (channel === 'wxpay' ? res.wxpayDisabled : res.alipayDisabled) ? 'warning' : 'success'
    })
  } catch (e) {
    toast.add({ title: '切换支付渠道开关失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    configBusy.value = null
  }
}
onMounted(() => {
  void loadConfig()
})

function pickStatus(s: string) {
  statusFilter.value = s
  void load(1)
}

// ---- 查询到账:对非 paid 订单主动查网关,确认已支付则补入账(状态置 paid + 发放 token) ----
const queryBusyId = ref<string | null>(null)

async function queryArrival(r: RechargeRow) {
  if (queryBusyId.value) return
  queryBusyId.value = r.id
  try {
    const res = await $fetch<{ status: string, credited: boolean, message: string }>('/api/admin/recharge/query-order', {
      method: 'POST',
      body: { orderNo: r.orderNo }
    })
    if (res.credited) {
      toast.add({ title: '已到账', description: `${r.packageName} 已更新为已支付并发放 token`, color: 'success' })
      await load(page.value)
    } else if (res.status === 'paid') {
      toast.add({ title: '订单已支付', description: res.message, color: 'success' })
    } else {
      toast.add({ title: '尚未到账', description: res.message, color: 'warning' })
    }
  } catch (e) {
    toast.add({ title: '查询到账失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    queryBusyId.value = null
  }
}

// ---- 充值测试:创建 0.1 元订单,走真实支付回调链路验证到账 ----
const testOpen = ref(false)
const testBusy = ref<'wxpay' | 'alipay' | null>(null)
const testError = ref('')

async function startTest(payType: 'wxpay' | 'alipay') {
  if (testBusy.value) return
  testBusy.value = payType
  testError.value = ''
  try {
    const res = await $fetch<{ action: string, params: Record<string, string> }>('/api/admin/recharge/test-create', {
      method: 'POST',
      body: { payType }
    })
    testOpen.value = false
    // 与用户充值时一致的动态 form POST 跳转网关收银台
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = res.action
    form.style.display = 'none'
    for (const [k, v] of Object.entries(res.params)) {
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = k
      input.value = v
      form.appendChild(input)
    }
    document.body.appendChild(form)
    form.submit()
  } catch (e) {
    testError.value = e instanceof Error ? e.message : String(e)
  } finally {
    testBusy.value = null
  }
}

function fmtTs(ts: number | null) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          充值记录
        </h1>
        <p class="text-sm text-neutral-500">
          全部 token 加油包订单(微支付网关回调入账,无需人工确认)
        </p>
      </div>
      <div class="flex items-start gap-6">
        <!-- 渠道开关:按渠道单独启停,两渠道都关闭 = 用户端全局维护 -->
        <div
          v-for="ch in ([{ key: 'wxpay', label: '微信支付', disabled: wxpayDisabled, reason: wxpayReason }, { key: 'alipay', label: '支付宝', disabled: alipayDisabled, reason: alipayReason }] as const)"
          :key="ch.key"
          class="flex flex-col items-end gap-1"
        >
          <p class="text-xs text-neutral-500">
            {{ ch.label }}
          </p>
          <USwitch
            :model-value="!ch.disabled"
            :loading="configBusy === ch.key"
            color="primary"
            :aria-label="`${ch.label}开关`"
            @update:model-value="toggleChannel(ch.key)"
          />
          <p
            class="text-xs font-medium"
            :class="ch.disabled ? 'text-amber-600' : 'text-emerald-600'"
          >
            {{ ch.disabled ? '已禁用' : '开放中' }}
          </p>
          <p
            v-if="ch.disabled && ch.reason"
            class="max-w-64 text-right text-xs text-amber-600"
            :title="ch.reason"
          >
            原因:{{ ch.reason }}
          </p>
        </div>
        <!-- 全局维护状态(两渠道都关闭,或健康检查自动维护) -->
        <div
          v-if="wxpayDisabled && alipayDisabled"
          class="flex flex-col items-end gap-1"
        >
          <p class="text-xs text-neutral-500">
            充值入口
          </p>
          <p class="text-xs font-medium text-amber-600">
            维护中(两渠道均已关闭)
          </p>
          <p
            v-if="maintenanceReason"
            class="max-w-64 text-right text-xs text-amber-600"
            :title="maintenanceReason"
          >
            原因:{{ maintenanceReason }}
          </p>
        </div>
        <UButton
          color="warning"
          variant="soft"
          icon="i-lucide-flask-conical"
          @click="testOpen = true"
        >
          充值测试(0.1 元)
        </UButton>
      </div>
    </div>

    <!-- 收入统计(已支付订单实付金额) -->
    <div class="mb-4 grid gap-4 sm:grid-cols-3">
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-900">
            <UIcon
              name="i-lucide-wallet"
              class="size-5 text-emerald-600"
            />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-neutral-500">
              总收入
            </p>
            <p class="truncate text-xl font-bold tabular-nums">
              ¥{{ fmtYuan(revenue.total) }}
            </p>
          </div>
        </div>
      </UCard>
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-900">
            <UIcon
              name="i-lucide-calendar-days"
              class="size-5 text-primary"
            />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-neutral-500">
              近 30 天收入
            </p>
            <p class="truncate text-xl font-bold tabular-nums">
              ¥{{ fmtYuan(revenue.day30) }}
            </p>
          </div>
        </div>
      </UCard>
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-900">
            <UIcon
              name="i-lucide-activity"
              class="size-5 text-rose-500"
            />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-neutral-500">
              近 24 小时收入
            </p>
            <p class="truncate text-xl font-bold tabular-nums">
              ¥{{ fmtYuan(revenue.day24) }}
            </p>
          </div>
        </div>
      </UCard>
    </div>

    <!-- 状态筛选(计数来自接口统计) -->
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <UButton
        :color="statusFilter === '' ? 'primary' : 'neutral'"
        :variant="statusFilter === '' ? 'solid' : 'outline'"
        size="sm"
        @click="pickStatus('')"
      >
        全部 {{ stats.reduce((s, x) => s + x.n, 0) }}
      </UButton>
      <UButton
        v-for="s in ['pending', 'paid', 'closed', 'refunded']"
        :key="s"
        :color="statusFilter === s ? 'primary' : 'neutral'"
        :variant="statusFilter === s ? 'solid' : 'outline'"
        size="sm"
        @click="pickStatus(s)"
      >
        {{ ORDER_STATUS[s]?.text ?? s }} {{ stats.find(x => x.status === s)?.n ?? 0 }}
      </UButton>
    </div>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                用户
              </th>
              <th class="py-2 pr-3 font-medium">
                套餐
              </th>
              <th class="py-2 pr-3 font-medium">
                金额
              </th>
              <th class="py-2 pr-3 font-medium">
                支付方式
              </th>
              <th class="py-2 pr-3 font-medium">
                状态
              </th>
              <th class="py-2 pr-3 font-medium">
                支付时间
              </th>
              <th class="py-2 pr-3 font-medium">
                创建时间
              </th>
              <th class="py-2 font-medium">
                订单号
              </th>
              <th class="py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td
                colspan="9"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="9"
                class="py-6 text-center text-neutral-500"
              >
                暂无充值记录
              </td>
            </tr>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="max-w-44 py-2.5 pr-3">
                <p class="truncate font-medium">
                  {{ r.userName || '匿名用户' }}
                </p>
                <p class="truncate text-xs text-neutral-500">
                  {{ r.userEmail || '—' }}
                </p>
              </td>
              <td class="py-2.5 pr-3">
                <p class="truncate">
                  {{ r.packageName }}
                </p>
                <p class="text-xs text-neutral-500">
                  {{ r.packageId }}
                </p>
              </td>
              <td class="py-2.5 pr-3 tabular-nums">
                ¥{{ (r.amount / 100).toFixed(2) }}
              </td>
              <td class="py-2.5 pr-3">
                {{ PROVIDER_LABELS[r.provider] ?? r.provider }}
              </td>
              <td class="py-2.5 pr-3">
                <span :class="ORDER_STATUS[r.status]?.cls ?? 'text-neutral-500'">
                  {{ ORDER_STATUS[r.status]?.text ?? r.status }}
                </span>
              </td>
              <td class="py-2.5 pr-3">
                {{ fmtTs(r.paidAt) }}
              </td>
              <td class="py-2.5 pr-3">
                {{ fmtTs(r.createdAt) }}
              </td>
              <td class="py-2.5 font-mono text-xs text-neutral-500">
                {{ r.orderNo }}
              </td>
              <td class="py-2.5">
                <UButton
                  v-if="r.status === 'pending'"
                  size="xs"
                  color="primary"
                  variant="soft"
                  icon="i-lucide-refresh-cw"
                  :loading="queryBusyId === r.id"
                  :disabled="queryBusyId !== null && queryBusyId !== r.id"
                  @click="queryArrival(r)"
                >
                  查询到账
                </UButton>
                <span
                  v-else
                  class="text-xs text-neutral-300 dark:text-neutral-700"
                >
                  —
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div
        v-if="total > pageSize"
        class="mt-4 flex items-center justify-between gap-3 border-t border-neutral-100 pt-4 dark:border-neutral-900"
      >
        <p class="text-xs text-neutral-500">
          共 {{ total }} 条
        </p>
        <UPagination
          v-model:page="page"
          :items-per-page="pageSize"
          :total="total"
          show-edges
          @update:page="load"
        />
      </div>
    </UCard>

    <!-- 充值测试弹窗 -->
    <UModal
      v-model:open="testOpen"
      title="充值测试(0.1 元)"
    >
      <template #body>
        <div class="space-y-4">
          <UAlert
            color="warning"
            variant="soft"
            icon="i-lucide-circle-alert"
            title="测试说明"
            description="创建一笔 0.1 元测试订单,走与用户充值完全相同的支付与回调链路。支付成功后订单会变为已支付(不入账 token),请到网关完成付款后回到本页确认到账。"
          />
          <p
            v-if="testError"
            class="text-sm text-red-500"
          >
            {{ testError }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="grid w-full grid-cols-2 gap-2">
          <UButton
            block
            class="bg-[#07C160]! text-white!"
            :loading="testBusy === 'wxpay'"
            :disabled="testBusy !== null"
            @click="startTest('wxpay')"
          >
            <UIcon
              name="i-simple-icons-wechat"
              class="size-5 shrink-0"
            />
            微信支付 0.1 元
          </UButton>
          <UButton
            block
            class="bg-[#1677FF]! text-white!"
            :loading="testBusy === 'alipay'"
            :disabled="testBusy !== null"
            @click="startTest('alipay')"
          >
            <UIcon
              name="i-simple-icons-alipay"
              class="size-5 shrink-0"
            />
            支付宝 0.1 元
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
