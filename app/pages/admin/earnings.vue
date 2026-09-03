<script setup lang="ts">
// /admin/earnings — 收益发放(管理后台):搜索指定用户 → 填 token 数量与自定义原因 → 发放为「待领取收益」,
// 收款用户在个人中心「收益」里一键领取后才入账。下方为发放历史(可分页/按收款人搜索)。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 收益发放' })

const toast = useToast()

interface UserOption { id: string, name: string, email: string | null }

// ---- 收款人搜索与单选(复用 /api/admin/users?q= 模糊搜索) ----
const search = ref('')
const candidates = ref<UserOption[]>([])
const searching = ref(false)
const recipient = ref<UserOption | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void doSearch()
  }, 300)
})

async function doSearch() {
  const q = search.value.trim()
  if (!q) {
    candidates.value = []
    return
  }
  searching.value = true
  try {
    const res = await $fetch<{ rows: UserOption[] }>(`/api/admin/users?q=${encodeURIComponent(q)}&pageSize=20`)
    candidates.value = res.rows.filter(u => u.id !== recipient.value?.id)
  } catch {
    candidates.value = []
  } finally {
    searching.value = false
  }
}

function pickRecipient(u: UserOption) {
  recipient.value = u
  candidates.value = []
  search.value = u.name || u.email || ''
}

function clearRecipient() {
  recipient.value = null
  search.value = ''
}

// ---- 发放表单 ----
const amount = ref<number | null>(null)
const reason = ref('')
const sending = ref(false)
const sendError = ref<string | null>(null)

/** token 快捷档位(0.5M 起步到 5M) */
const QUICK_AMOUNTS = [500_000, 1_000_000, 2_000_000, 5_000_000]

/** 快捷档位显示:M 制,整数不带小数点(0.5M / 1M / 2M / 5M) */
function fmtM(v: number) {
  const m = v / 1_000_000
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
}

/** 发放表单模态框开关 */
const grantOpen = ref(false)
/** 发放范围:single=指定用户 | all=全部注册用户 */
const grantMode = ref<'single' | 'all'>('single')

function openGrant() {
  // 每次打开重置表单,避免残留上次输入
  grantMode.value = 'single'
  recipient.value = null
  search.value = ''
  candidates.value = []
  amount.value = null
  reason.value = ''
  sendError.value = null
  grantOpen.value = true
}

async function onSend() {
  sendError.value = null
  if (grantMode.value === 'single' && !recipient.value) {
    sendError.value = '请先选择收款用户'
    return
  }
  const amt = Number(amount.value)
  if (!Number.isInteger(amt) || amt <= 0) {
    sendError.value = '请输入大于 0 的整数 token 数量'
    return
  }
  sending.value = true
  try {
    const body = grantMode.value === 'all'
      ? { all: true, amount: amt, reason: reason.value.trim() }
      : { userId: recipient.value!.id, amount: amt, reason: reason.value.trim() }
    const res = await $fetch<{ ok: true, id?: string, count?: number }>('/api/admin/earnings/send', {
      method: 'POST',
      body
    })
    toast.add({
      title: grantMode.value === 'all'
        ? `已向全部 ${res.count ?? 0} 位用户发放 ${amt.toLocaleString()} tokens(待领取)`
        : `已向 ${recipient.value!.name || recipient.value!.email} 发放 ${amt.toLocaleString()} tokens(待领取)`,
      color: 'success'
    })
    grantOpen.value = false
    amount.value = null
    reason.value = ''
    clearRecipient()
    void load(1)
  } catch (e) {
    sendError.value = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}

// ---- 发放历史(收益账本) ----
interface EarningRow {
  id: string
  userId: string
  recipientName: string | null
  recipientEmail: string | null
  amount: number
  sourceType: string
  itemTitle: string
  reason: string | null
  status: 'pending' | 'claimed'
  createdAt: number
  claimedAt: number | null
}
const rows = ref<EarningRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const listQ = ref('')
let listTimer: ReturnType<typeof setTimeout> | null = null

watch(listQ, () => {
  if (listTimer) clearTimeout(listTimer)
  listTimer = setTimeout(() => {
    listTimer = null
    void load(1)
  }, 300)
})

async function load(pageNum = page.value) {
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(pageNum), pageSize: String(pageSize) })
    if (listQ.value.trim()) query.set('q', listQ.value.trim())
    const res = await $fetch<{ rows: EarningRow[], total: number }>(`/api/admin/earnings?${query}`)
    rows.value = res.rows
    total.value = res.total
    page.value = pageNum
  } catch (e) {
    toast.add({ title: '加载发放历史失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load(1)
})

function fmtTs(ts: number | null) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6 px-4 py-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          收益发放
        </h1>
        <p class="mt-1 text-sm text-neutral-500">
          发放的收益先进入收款人的「待领取收益」(个人中心显示角标),由对方一键领取后才入账
        </p>
      </div>
      <UButton
        color="primary"
        icon="i-lucide-hand-coins"
        @click="openGrant"
      >
        手动发放收益
      </UButton>
    </div>

    <!-- 手动发放收益:表单收进模态框,页面只保留入口按钮 -->
    <UModal
      v-model:open="grantOpen"
      title="手动发放收益"
    >
      <template #body>
        <div class="space-y-4">
        <!-- 发放范围:指定用户 / 全部用户 -->
        <div class="grid grid-cols-2 gap-1.5 rounded-lg border border-neutral-200 p-1 dark:border-neutral-700">
          <UButton
            size="sm"
            color="primary"
            block
            :variant="grantMode === 'single' ? 'solid' : 'ghost'"
            @click="grantMode = 'single'"
          >
            指定用户
          </UButton>
          <UButton
            size="sm"
            color="primary"
            block
            :variant="grantMode === 'all' ? 'solid' : 'ghost'"
            @click="grantMode = 'all'"
          >
            全部用户
          </UButton>
        </div>

        <!-- 指定用户:搜索单选 -->
        <div v-if="grantMode === 'single'">
          <p class="mb-1.5 text-sm font-medium">
            收款用户
          </p>
          <UInput
            v-model="search"
            placeholder="搜索昵称 / 邮箱…"
            :loading="searching"
          >
            <template #trailing>
              <UButton
                v-if="recipient"
                icon="i-lucide-x"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="清除选择"
                @click="clearRecipient"
              />
            </template>
          </UInput>
          <div
            v-if="candidates.length > 0"
            class="mt-1.5 space-y-1 rounded-lg border border-neutral-200 py-1 dark:border-neutral-700"
          >
            <button
              v-for="u in candidates"
              :key="u.id"
              type="button"
              class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
              @click="pickRecipient(u)"
            >
              <span class="min-w-0 truncate font-medium">{{ u.name }}</span>
              <span class="shrink-0 text-xs text-neutral-500">{{ u.email }}</span>
            </button>
          </div>
          <div
            v-if="recipient"
            class="mt-1.5 flex flex-wrap items-center gap-1.5"
          >
            <UBadge
              color="primary"
              variant="soft"
              size="sm"
            >
              {{ recipient.name }}
            </UBadge>
            <span class="text-xs text-neutral-500">{{ recipient.email }}</span>
          </div>
        </div>

        <!-- 全部用户:无需选择具体用户 -->
        <p
          v-else
          class="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
        >
          将向全部注册用户发放等额 token,每人生成一条「待领取」收益
        </p>

        <div>
          <p class="mb-1.5 text-sm font-medium">
            发放数量(token)
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <UInput
              v-model.number="amount"
              type="number"
              min="1"
              placeholder="整数 token 数量"
              class="w-44"
            />
            <UButton
              v-for="v in QUICK_AMOUNTS"
              :key="v"
              size="xs"
              color="neutral"
              variant="soft"
              @click="amount = v"
            >
              {{ fmtM(v) }}
            </UButton>
          </div>
        </div>

        <div>
          <p class="mb-1.5 text-sm font-medium">
            原因(展示给收款人)
          </p>
          <UInput
            v-model="reason"
            class="w-full"
            :maxlength="200"
            placeholder="如:优质内容奖励 / 活动补偿 / 问题致歉…"
          />
        </div>

        <p
          v-if="sendError"
          class="text-sm text-red-500"
        >
          {{ sendError }}
        </p>

        <UButton
          color="primary"
          icon="i-lucide-hand-coins"
          :loading="sending"
          class="self-start"
          @click="onSend"
        >
          发放收益
        </UButton>
        </div>
      </template>
    </UModal>

    <!-- 发放历史 -->
    <UCard title="发放历史">
      <template #default>
        <UInput
          v-model="listQ"
          icon="i-lucide-search"
          placeholder="按收款人昵称/邮箱搜索…"
          class="mb-3 max-w-sm"
        />
        <p
          v-if="loading && rows.length === 0"
          class="py-6 text-center text-sm text-neutral-500"
        >
          加载中…
        </p>
        <p
          v-else-if="rows.length === 0"
          class="py-6 text-center text-sm text-neutral-500"
        >
          暂无发放记录
        </p>
        <div
          v-for="r in rows"
          :key="r.id"
          class="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700"
        >
          <div class="min-w-0">
            <p class="truncate font-medium">
              {{ r.itemTitle }}
              <span class="text-xs font-normal text-neutral-500">→ {{ r.recipientName || r.recipientEmail }}</span>
            </p>
            <p class="truncate text-xs text-neutral-500">
              {{ fmtTs(r.createdAt) }}{{ r.reason ? ` · ${r.reason}` : '' }}{{ r.claimedAt != null ? ` · 已领取 ${fmtTs(r.claimedAt)}` : '' }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <UBadge
              :color="r.status === 'claimed' ? 'success' : 'neutral'"
              variant="soft"
              size="sm"
            >
              {{ r.status === 'claimed' ? '已领取' : '待领取' }}
            </UBadge>
            <span class="tabular-nums font-semibold text-highlighted">+{{ r.amount.toLocaleString() }}</span>
          </div>
        </div>
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
      </template>
    </UCard>
  </div>
</template>
