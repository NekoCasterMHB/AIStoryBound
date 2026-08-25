<script setup lang="ts">
import { useAuthSession } from '../../utils/auth-client'
import type { RadioGroupItem } from '@nuxt/ui'

// /admin — 兑换码管理(管理后台 layout 首个页面;管理员校验前置到路由中间件
// middleware/admin.ts,非管理员在进入页面前就被重定向回首页;接口层 requireAdmin 二次鉴权兜底)
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI SpankWorld · 兑换码管理' })

const { data: session } = await useAuthSession()
const toast = useToast()

interface RedeemCodeRow {
  id: string
  code: string
  tokens: number
  usedCount: number
  maxUses: number | null
  perUserLimit: number
  disabled: number
  expiresAt: number | null
  createdAt: number
}
interface RedemptionRow {
  id: string
  tokens: number
  createdAt: number
  userEmail: string | null
  userName: string | null
}

const isAdmin = ref(false)
const codes = ref<RedeemCodeRow[]>([])
const codesLoading = ref(false)

async function loadCodes() {
  codesLoading.value = true
  try {
    codes.value = await $fetch<RedeemCodeRow[]>('/api/admin/redeem/list')
    isAdmin.value = true
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    if (status === 401 || status === 403) {
      // 兜底:中间件已拦截非管理员,这里只在权限被中途撤销等极端情况下触发
      toast.add({
        title: status === 401 ? '请先登录' : '当前账号无管理权限',
        description: '正在为你跳转到首页…',
        color: 'error'
      })
      await navigateTo('/')
    } else {
      // 非鉴权类错误(如服务器 500):放行页面,列表留空由 toast 提示
      isAdmin.value = true
      toast.add({ title: '加载兑换码列表失败,请刷新重试', color: 'error' })
    }
  } finally {
    codesLoading.value = false
  }
}
onMounted(() => { void loadCodes() })

// ---- 生成表单 ----
type RuleValue = 'activity' | 'limited' | 'oneTime'

/** token 快捷档位(1M = 100 万) */
const TOKEN_QUICK = [
  { label: '1M', value: 1_000_000 },
  { label: '3M', value: 3_000_000 },
  { label: '5M', value: 5_000_000 }
]

const RULE_ITEMS: RadioGroupItem[] = [
  { label: '每人限一次 · 不限总量', value: 'activity', description: '活动码:一个码可被多个用户兑换,每个账号限领一次,不限制总次数' },
  { label: '每人限一次 · 限量 N 次', value: 'limited', description: '活动码:每人限领一次,总次数领完即止,适合限定规模的活动' },
  { label: '一码一用', value: 'oneTime', description: '每个码只能被兑换一次,用完即废,适合邀请码/定向发放' }
]

const form = ref({
  tokens: '',
  count: '1',
  rule: 'activity' as RuleValue,
  maxUses: '',
  expireDays: ''
})

const creating = ref(false)
const createdCodes = ref<string[]>([])

async function createCodes() {
  const tokens = Math.floor(Number(form.value.tokens))
  const count = Math.floor(Number(form.value.count))
  if (!Number.isFinite(tokens) || tokens <= 0) {
    toast.add({ title: '请填写每个码可兑换的 token 数', color: 'error' })
    return
  }
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    toast.add({ title: '生成数量需在 1~100 之间', color: 'error' })
    return
  }
  let maxUses: number | null = null
  if (form.value.rule === 'limited') {
    maxUses = Math.floor(Number(form.value.maxUses))
    if (!Number.isFinite(maxUses) || maxUses < 1) {
      toast.add({ title: '请填写总用量上限', color: 'error' })
      return
    }
  } else if (form.value.rule === 'oneTime') {
    maxUses = 1
  }
  const expireDays = form.value.expireDays
  const expiresAt = expireDays && Number(expireDays) > 0
    ? Date.now() + Number(expireDays) * 24 * 60 * 60 * 1000
    : null

  creating.value = true
  try {
    const res = await $fetch<{ ok: true, codes: string[] }>('/api/admin/redeem/create', {
      method: 'POST',
      body: {
        tokens,
        count,
        maxUses,
        perUserLimit: 1,
        expiresAt
      }
    })
    createdCodes.value = res.codes
    toast.add({ title: `已生成 ${res.codes.length} 个兑换码`, color: 'success' })
    void loadCodes()
  } catch (e) {
    toast.add({
      title: '生成失败',
      description: e instanceof Error ? e.message : String(e),
      color: 'error'
    })
  } finally {
    creating.value = false
  }
}

async function copyCodes() {
  const text = createdCodes.value.join('\n')
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: `已复制 ${createdCodes.value.length} 个兑换码`, color: 'success' })
  } catch {
    toast.add({ title: '复制失败,请手动选择复制', color: 'error' })
  }
}

async function copyCode(row: RedeemCodeRow) {
  try {
    await navigator.clipboard.writeText(row.code)
    toast.add({ title: '已复制兑换码', color: 'success' })
  } catch {
    toast.add({ title: '复制失败,请手动复制', color: 'error' })
  }
}

// ---- 停用/恢复 ----
async function toggleDisable(row: RedeemCodeRow) {
  try {
    await $fetch(`/api/admin/redeem/${row.id}/disable`, {
      method: 'POST',
      body: { disabled: row.disabled === 0 }
    })
    toast.add({ title: row.disabled === 0 ? '已停用(不可再兑换)' : '已恢复', color: 'success' })
    void loadCodes()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 兑换明细 ----
const detailOpen = ref(false)
const detail = ref<{ code: string, tokens: number, redemptions: RedemptionRow[] } | null>(null)
const detailLoading = ref(false)

async function openDetail(row: RedeemCodeRow) {
  detailOpen.value = true
  detailLoading.value = true
  detail.value = null
  try {
    detail.value = await $fetch(`/api/admin/redeem/${row.id}`)
  } catch (e) {
    toast.add({ title: '加载明细失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    detailLoading.value = false
  }
}

// ---- 展示工具 ----
function fmtTs(ts: number | null) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function statusOf(row: RedeemCodeRow): { text: string, cls: string } {
  if (row.disabled === 1) return { text: '已停用', cls: 'text-red-500' }
  if (row.expiresAt && row.expiresAt < Date.now()) return { text: '已过期', cls: 'text-neutral-400' }
  if (row.maxUses !== null && row.usedCount >= row.maxUses) return { text: '已领完', cls: 'text-amber-600' }
  return { text: '有效', cls: 'text-emerald-600' }
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          兑换码管理
        </h1>
        <p class="text-sm text-neutral-500">
          {{ session?.user?.email || '—' }} · 生成兑换码用于活动赠送,用户可在个人中心兑换 token
        </p>
      </div>
    </div>

    <!-- 校验完成前只显示加载态;非管理员会在校验失败时被重定向回首页 -->
    <div v-if="!isAdmin" class="py-10 text-center text-sm text-neutral-500">
      正在校验管理权限…
    </div>

    <template v-else>
      <!-- 生成表单 -->
      <UCard class="mb-6">
        <p class="mb-4 font-semibold">
          生成兑换码
        </p>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="每个码可兑换 token 数" required>
            <div class="flex gap-2">
              <UInput v-model="form.tokens" type="number" min="1" placeholder="自定义数量" class="flex-1" />
              <UButton
                v-for="p in TOKEN_QUICK"
                :key="p.label"
                :color="Number(form.tokens) === p.value ? 'primary' : 'neutral'"
                :variant="Number(form.tokens) === p.value ? 'solid' : 'outline'"
                @click="form.tokens = String(p.value)"
              >
                {{ p.label }}
              </UButton>
            </div>
          </UFormField>
          <UFormField label="生成数量" required>
            <UInput v-model="form.count" type="number" min="1" max="100" />
          </UFormField>
        </div>

        <UFormField label="核销规则" class="mt-4">
          <URadioGroup
            v-model="form.rule"
            color="primary"
            variant="card"
            :items="RULE_ITEMS"
          />
        </UFormField>

        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <UFormField v-if="form.rule === 'limited'" label="总用量上限(可兑换总次数)" required>
            <UInput v-model="form.maxUses" type="number" min="1" placeholder="如 100" />
          </UFormField>
          <UFormField label="有效期(天,留空 = 永不过期)">
            <UInput v-model="form.expireDays" type="number" min="1" placeholder="如 30" />
          </UFormField>
        </div>

        <UButton
          class="mt-5"
          color="primary"
          icon="i-lucide-ticket-plus"
          :loading="creating"
          block
          @click="createCodes"
        >
          生成兑换码
        </UButton>
      </UCard>

      <!-- 生成结果(仅本次生成可见) -->
      <UCard v-if="createdCodes.length" class="mb-6">
        <div class="mb-3 flex items-center justify-between gap-3">
          <p class="font-semibold">
            本次生成的兑换码(共 {{ createdCodes.length }} 个,请立即复制保存)
          </p>
          <UButton
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-copy"
            @click="copyCodes"
          >
            一键复制
          </UButton>
        </div>
        <pre class="max-h-60 overflow-auto whitespace-pre rounded-lg bg-neutral-100 p-3 font-mono text-sm leading-6 dark:bg-neutral-900">{{ createdCodes.join('\n') }}</pre>
      </UCard>

      <!-- 码列表 -->
      <UCard>
        <p class="mb-3 font-semibold">
          全部兑换码
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
                <th class="py-2 pr-3 font-medium">
                  兑换码
                </th>
                <th class="py-2 pr-3 font-medium">
                  token
                </th>
                <th class="py-2 pr-3 font-medium">
                  用量
                </th>
                <th class="py-2 pr-3 font-medium">
                  状态
                </th>
                <th class="py-2 pr-3 font-medium">
                  过期时间
                </th>
                <th class="py-2 pr-3 font-medium">
                  创建时间
                </th>
                <th class="py-2 font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="codesLoading">
                <td colspan="7" class="py-6 text-center text-neutral-500">
                  加载中…
                </td>
              </tr>
              <tr v-else-if="!codes.length">
                <td colspan="7" class="py-6 text-center text-neutral-500">
                  还没有兑换码,先在上面生成
                </td>
              </tr>
              <tr
                v-for="row in codes"
                :key="row.id"
                class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
              >
                <td class="py-2.5 pr-3 font-mono text-xs">
                  <button class="hover:underline" @click="copyCode(row)">
                    {{ row.code }}
                  </button>
                </td>
                <td class="py-2.5 pr-3 tabular-nums">
                  {{ row.tokens.toLocaleString() }}
                </td>
                <td class="py-2.5 pr-3 tabular-nums">
                  {{ row.usedCount.toLocaleString() }}{{ row.maxUses !== null ? ` / ${row.maxUses.toLocaleString()}` : '' }}
                </td>
                <td class="py-2.5 pr-3">
                  <span :class="statusOf(row).cls">
                    {{ statusOf(row).text }}
                  </span>
                </td>
                <td class="py-2.5 pr-3">
                  {{ fmtTs(row.expiresAt) }}
                </td>
                <td class="py-2.5 pr-3">
                  {{ fmtTs(row.createdAt) }}
                </td>
                <td class="py-2.5">
                  <div class="flex gap-1">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="soft"
                      icon="i-lucide-list-tree"
                      @click="openDetail(row)"
                    >
                      明细
                    </UButton>
                    <UButton
                      size="xs"
                      :color="row.disabled === 1 ? 'success' : 'error'"
                      variant="soft"
                      :icon="row.disabled === 1 ? 'i-lucide-rotate-ccw' : 'i-lucide-ban'"
                      @click="toggleDisable(row)"
                    >
                      {{ row.disabled === 1 ? '恢复' : '停用' }}
                    </UButton>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>

      <!-- 兑换明细 -->
      <UModal v-model:open="detailOpen" :title="`兑换明细 · ${detail?.code ?? ''}`">
        <template #body>
          <div v-if="detailLoading" class="py-6 text-center text-sm text-neutral-500">
            加载中…
          </div>
          <template v-else>
            <p v-if="!detail?.redemptions.length" class="py-4 text-center text-sm text-neutral-500">
              还没有人兑换
            </p>
            <ul v-else class="divide-y divide-neutral-100 dark:divide-neutral-900">
              <li
                v-for="r in detail.redemptions"
                :key="r.id"
                class="flex items-center justify-between gap-3 py-2.5 text-sm"
              >
                <div class="min-w-0">
                  <p class="truncate font-medium">
                    {{ r.userName || '匿名用户' }}
                  </p>
                  <p class="truncate text-xs text-neutral-500">
                    {{ r.userEmail || '—' }}
                  </p>
                </div>
                <div class="shrink-0 text-right">
                  <p class="tabular-nums text-emerald-600">
                    +{{ r.tokens.toLocaleString() }} tokens
                  </p>
                  <p class="text-xs text-neutral-500">
                    {{ fmtTs(r.createdAt) }}
                  </p>
                </div>
              </li>
            </ul>
          </template>
        </template>
      </UModal>
    </template>
  </div>
</template>