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
const pageSize = 20
const stats = ref<{ status: string, n: number }[]>([])
const loading = ref(false)
const statusFilter = ref('')

async function load(pageNum = page.value) {
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(pageNum), pageSize: String(pageSize) })
    if (statusFilter.value) query.set('status', statusFilter.value)
    const res = await $fetch<{ rows: RechargeRow[], total: number, stats: { status: string, n: number }[] }>(
      `/api/admin/recharge/list?${query}`
    )
    rows.value = res.rows
    total.value = res.total
    stats.value = res.stats
    page.value = pageNum
  } catch (e) {
    toast.add({ title: '加载充值记录失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => { void load(1) })

function pickStatus(s: string) {
  statusFilter.value = s
  void load(1)
}

function fmtTs(ts: number | null) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5">
      <h1 class="text-xl font-semibold">
        充值记录
      </h1>
      <p class="text-sm text-neutral-500">
        全部 token 加油包订单(微支付网关回调入账,无需人工确认)
      </p>
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
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="8" class="py-6 text-center text-neutral-500">
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td colspan="8" class="py-6 text-center text-neutral-500">
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
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div v-if="total > pageSize" class="mt-4 flex items-center justify-between border-t border-neutral-100 pt-4 dark:border-neutral-900">
        <p class="text-xs text-neutral-500">
          共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页
        </p>
        <div class="flex gap-2">
          <UButton size="sm" color="neutral" variant="soft" :disabled="page <= 1" @click="load(page - 1)">
            上一页
          </UButton>
          <UButton size="sm" color="neutral" variant="soft" :disabled="page >= totalPages" @click="load(page + 1)">
            下一页
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>