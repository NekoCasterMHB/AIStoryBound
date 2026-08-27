<script setup lang="ts">
// /admin/users — 用户管理(管理后台):全部注册用户列表,展示 token 余额、累计消费 token 与累计充值金额,
// 支持按 token 余额 / 消费量 / 充值金额 / 注册时间排序(点击表头切换升/降序)与分页。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 用户管理' })

const toast = useToast()

interface UserRow {
  id: string
  name: string
  email: string | null
  emailVerified: boolean
  aiTokenBalance: number
  consumed: number
  /** 分 */
  recharged: number
  createdAt: number
}

type SortField = 'balance' | 'consumed' | 'recharged' | 'createdAt'

const rows = ref<UserRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const sort = ref<SortField>('createdAt')
const dir = ref<'asc' | 'desc'>('desc')
const stats = ref<{ totalUsers: number, totalBalance: number, totalConsumed: number }>({ totalUsers: 0, totalBalance: 0, totalConsumed: 0 })

async function load(pageNum = page.value) {
  loading.value = true
  try {
    const query = new URLSearchParams({
      page: String(pageNum),
      pageSize: String(pageSize),
      sort: sort.value,
      dir: dir.value
    })
    const res = await $fetch<{ rows: UserRow[], total: number, stats: typeof stats.value }>(`/api/admin/users?${query}`)
    rows.value = res.rows
    total.value = res.total
    stats.value = res.stats
    page.value = pageNum
  } catch (e) {
    toast.add({ title: '加载用户列表失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load(1)
})

/** 点击表头排序:同列切换升/降序,新列默认降序 */
function setSort(field: SortField) {
  if (sort.value === field) {
    dir.value = dir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sort.value = field
    dir.value = 'desc'
  }
  void load(1)
}

function sortIcon(field: SortField) {
  if (sort.value !== field) return 'i-lucide-chevrons-up-down'
  return dir.value === 'asc' ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down'
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 分 → 元 */
function fmtYuan(fen: number) {
  return (fen / 100).toFixed(2)
}

function fmtTs(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          用户管理
        </h1>
        <p class="text-sm text-neutral-500">
          全部注册用户(点击表头可按 token 余额 / 消费量 / 充值金额 / 注册时间排序)
        </p>
      </div>
    </div>

    <!-- 汇总统计 -->
    <div class="mb-4 grid gap-4 sm:grid-cols-3">
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-900">
            <UIcon
              name="i-lucide-users"
              class="size-5 text-primary"
            />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-neutral-500">
              注册用户总数
            </p>
            <p class="truncate text-xl font-bold tabular-nums">
              {{ stats.totalUsers.toLocaleString() }}
            </p>
          </div>
        </div>
      </UCard>
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
              token 余额总量
            </p>
            <p class="truncate text-xl font-bold tabular-nums">
              {{ fmtTokens(stats.totalBalance) }}
            </p>
          </div>
        </div>
      </UCard>
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-900">
            <UIcon
              name="i-lucide-flame"
              class="size-5 text-amber-600"
            />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-neutral-500">
              累计消费 token
            </p>
            <p class="truncate text-xl font-bold tabular-nums">
              {{ fmtTokens(stats.totalConsumed) }}
            </p>
          </div>
        </div>
      </UCard>
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
                <button
                  class="flex items-center gap-1 transition-colors hover:text-primary"
                  @click="setSort('balance')"
                >
                  token 余额
                  <UIcon
                    :name="sortIcon('balance')"
                    class="size-3.5"
                  />
                </button>
              </th>
              <th class="py-2 pr-3 font-medium">
                <button
                  class="flex items-center gap-1 transition-colors hover:text-primary"
                  @click="setSort('consumed')"
                >
                  消费 token
                  <UIcon
                    :name="sortIcon('consumed')"
                    class="size-3.5"
                  />
                </button>
              </th>
              <th class="py-2 pr-3 font-medium">
                <button
                  class="flex items-center gap-1 transition-colors hover:text-primary"
                  @click="setSort('recharged')"
                >
                  累计充值金额
                  <UIcon
                    :name="sortIcon('recharged')"
                    class="size-3.5"
                  />
                </button>
              </th>
              <th class="py-2 pr-3 font-medium">
                <button
                  class="flex items-center gap-1 transition-colors hover:text-primary"
                  @click="setSort('createdAt')"
                >
                  注册时间
                  <UIcon
                    :name="sortIcon('createdAt')"
                    class="size-3.5"
                  />
                </button>
              </th>
              <th class="py-2 font-medium">
                用户 ID
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td
                colspan="6"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="6"
                class="py-6 text-center text-neutral-500"
              >
                暂无注册用户
              </td>
            </tr>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="max-w-56 py-2.5 pr-3">
                <p class="truncate font-medium">
                  {{ r.name || '匿名用户' }}
                </p>
                <p class="truncate text-xs text-neutral-500">
                  {{ r.email || '—' }}
                </p>
              </td>
              <td class="py-2.5 pr-3">
                <span
                  class="font-medium tabular-nums"
                  :class="r.aiTokenBalance > 0 ? 'text-emerald-600' : 'text-neutral-400'"
                >
                  {{ fmtTokens(r.aiTokenBalance) }}
                </span>
              </td>
              <td class="py-2.5 pr-3 tabular-nums text-neutral-700 dark:text-neutral-300">
                {{ fmtTokens(r.consumed) }}
              </td>
              <td class="py-2.5 pr-3">
                <span
                  class="tabular-nums"
                  :class="r.recharged > 0 ? 'text-neutral-700 dark:text-neutral-300' : 'text-neutral-400'"
                >
                  ¥{{ fmtYuan(r.recharged) }}
                </span>
              </td>
              <td class="py-2.5 pr-3">
                {{ fmtTs(r.createdAt) }}
              </td>
              <td class="py-2.5 font-mono text-xs text-neutral-500">
                {{ r.id }}
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
  </div>
</template>
