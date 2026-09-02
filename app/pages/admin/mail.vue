<script setup lang="ts">
// /admin/mail — 站内邮件(管理后台):搜索注册用户 → 多选收件人 → 自由输入主题/内容 → 发送真实邮件,
// 逐封落 mail_sent 表;下方展示发送历史(时间/收件人/主题/状态,失败显示原因)。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 站内邮件' })

const toast = useToast()

const MAX_SUBJECT_CHARS = 200
const MAX_CONTENT_CHARS = 10_000

// ---- 收件人搜索与选择(复用 /api/admin/users?q= 模糊搜索) ----
interface UserOption { id: string, name: string, email: string | null }
const search = ref('')
const candidates = ref<UserOption[]>([])
const searching = ref(false)
const selected = ref<UserOption[]>([])
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
    // 已选中的不重复出现在候选里
    const picked = new Set(selected.value.map(u => u.id))
    candidates.value = res.rows.filter(u => !picked.has(u.id))
  } catch (e) {
    toast.add({ title: '搜索用户失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
    candidates.value = []
  } finally {
    searching.value = false
  }
}

function addRecipient(u: UserOption) {
  if (selected.value.some(x => x.id === u.id)) return
  selected.value.push(u)
  candidates.value = candidates.value.filter(x => x.id !== u.id)
}

function removeRecipient(id: string) {
  selected.value = selected.value.filter(x => x.id !== id)
}

// ---- 发送 ----
const subject = ref('')
const content = ref('')
const sending = ref(false)
const sendError = ref<string | null>(null)

async function onSend() {
  if (sending.value) return
  if (selected.value.length === 0) {
    sendError.value = '请至少选择一位收件人'
    return
  }
  if (!subject.value.trim()) {
    sendError.value = '邮件主题不能为空'
    return
  }
  if (!content.value.trim()) {
    sendError.value = '邮件内容不能为空'
    return
  }
  sending.value = true
  sendError.value = null
  try {
    const res = await $fetch<{ sent: number, failed: number, results: { email: string, ok: boolean, error?: string }[] }>('/api/admin/mail/send', {
      method: 'POST',
      body: { recipientIds: selected.value.map(u => u.id), subject: subject.value, content: content.value }
    })
    const fails = res.results.filter(r => !r.ok)
    if (res.failed > 0) {
      toast.add({
        title: `已发送 ${res.sent} 封,失败 ${res.failed} 封`,
        description: fails.map(f => `${f.email}: ${f.error ?? '未知原因'}`).join('; ').slice(0, 200),
        color: 'error'
      })
    } else {
      toast.add({ title: `已发送 ${res.sent} 封邮件`, color: 'success' })
    }
    // 发送成功(或部分成功)后清空表单,仅保留失败收件人方便重试
    selected.value = fails.length
      ? selected.value.filter(u => fails.some(f => f.email === u.email))
      : []
    subject.value = ''
    content.value = ''
    void load()
  } catch (e) {
    const data = (e as { data?: { statusMessage?: string } }).data
    sendError.value = data?.statusMessage ?? (e instanceof Error ? e.message : String(e))
  } finally {
    sending.value = false
  }
}

// ---- 发送历史(分页,按时间倒序) ----
interface MailRow {
  id: string
  recipientEmail: string
  recipientName: string | null
  subject: string
  content: string
  status: string
  error: string | null
  createdAt: number
}
const rows = ref<MailRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)

async function load(pageNum = page.value) {
  loading.value = true
  try {
    const res = await $fetch<{ rows: MailRow[], total: number }>(`/api/admin/mail?page=${pageNum}&pageSize=${pageSize}`)
    rows.value = res.rows
    total.value = res.total
    page.value = pageNum
  } catch (e) {
    toast.add({ title: '加载发送历史失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load(1)
})

function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5">
      <h1 class="text-xl font-semibold">
        站内邮件
      </h1>
      <p class="text-sm text-neutral-500">
        搜索注册用户作为收件人,发送站内邮件(走邮件服务送达用户邮箱);发送历史逐封记录
      </p>
    </div>

    <!-- 发送表单 -->
    <UCard class="mb-6">
      <div class="space-y-4">
        <!-- 收件人搜索 -->
        <UFormField
          label="收件人"
          :hint="selected.length ? `已选 ${selected.length} 位收件人` : '搜索昵称 / 邮箱 / 用户 ID'"
        >
          <div class="space-y-2">
            <UInput
              v-model="search"
              icon="i-lucide-search"
              placeholder="搜索昵称 / 邮箱 / 用户 ID"
              class="w-full max-w-md"
              :loading="searching"
            />
            <div
              v-if="search.trim() && candidates.length"
              class="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-neutral-200 p-1.5 dark:border-neutral-700"
            >
              <button
                v-for="u in candidates"
                :key="u.id"
                type="button"
                class="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
                @click="addRecipient(u)"
              >
                <span class="min-w-0">
                  <span class="font-medium">{{ u.name }}</span>
                  <span class="ml-2 text-xs text-neutral-500">{{ u.email || '未绑定邮箱' }}</span>
                </span>
                <UIcon
                  name="i-lucide-plus"
                  class="size-4 shrink-0 text-neutral-400"
                />
              </button>
            </div>
            <p
              v-else-if="search.trim() && !searching"
              class="text-xs text-neutral-400"
            >
              没有更多匹配用户(已选中的不出现在列表)
            </p>
          </div>
        </UFormField>

        <!-- 已选收件人 -->
        <div
          v-if="selected.length"
          class="flex flex-wrap gap-1.5"
        >
          <UBadge
            v-for="u in selected"
            :key="u.id"
            color="primary"
            variant="soft"
            size="md"
            class="gap-1.5 pe-1"
          >
            {{ u.name }}<span class="text-xs opacity-70">({{ u.email || '无邮箱' }})</span>
            <button
              type="button"
              class="rounded p-0.5 transition hover:text-red-500"
              :aria-label="`移除 ${u.name}`"
              @click="removeRecipient(u.id)"
            >
              <UIcon
                name="i-lucide-x"
                class="size-3.5"
              />
            </button>
          </UBadge>
        </div>

        <UFormField label="主题">
          <UInput
            v-model="subject"
            placeholder="邮件主题"
            :maxlength="MAX_SUBJECT_CHARS"
            class="w-full"
          />
        </UFormField>

        <UFormField label="内容">
          <UTextarea
            v-model="content"
            placeholder="邮件正文内容…"
            :maxlength="MAX_CONTENT_CHARS"
            autoresize
            :rows="6"
            class="w-full"
          />
        </UFormField>

        <p
          v-if="sendError"
          class="text-xs text-red-500"
        >
          {{ sendError }}
        </p>

        <div class="flex justify-end">
          <UButton
            icon="i-lucide-send"
            color="primary"
            :loading="sending"
            :disabled="selected.length === 0"
            @click="onSend"
          >
            发送{{ selected.length ? `(${selected.length})` : '' }}
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- 发送历史 -->
    <UCard>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          发送历史
        </h2>
        <span class="text-xs text-neutral-500">
          共 {{ total }} 条
        </span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                时间
              </th>
              <th class="py-2 pr-3 font-medium">
                收件人
              </th>
              <th class="py-2 pr-3 font-medium">
                主题
              </th>
              <th class="py-2 pr-3 font-medium">
                状态
              </th>
              <th class="py-2 font-medium">
                失败原因
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td
                colspan="5"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="5"
                class="py-6 text-center text-neutral-500"
              >
                暂无发送记录
              </td>
            </tr>
            <tr
              v-for="m in rows"
              :key="m.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="whitespace-nowrap py-2.5 pr-3 text-xs text-neutral-500">
                {{ fmtDateTime(m.createdAt) }}
              </td>
              <td class="max-w-56 truncate py-2.5 pr-3">
                <span class="font-medium">{{ m.recipientName || '—' }}</span>
                <span class="ml-1 text-xs text-neutral-500">{{ m.recipientEmail }}</span>
              </td>
              <td
                class="max-w-64 truncate py-2.5 pr-3"
                :title="m.content"
              >
                {{ m.subject }}
              </td>
              <td class="py-2.5 pr-3">
                <UBadge
                  size="sm"
                  :color="m.status === 'sent' ? 'success' : 'error'"
                  variant="soft"
                >
                  {{ m.status === 'sent' ? '已发送' : '失败' }}
                </UBadge>
              </td>
              <td class="max-w-64 truncate py-2.5 text-xs text-red-500">
                {{ m.error || '' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        v-if="total > pageSize"
        class="mt-4 flex justify-end"
      >
        <UPagination
          v-model="page"
          :page-count="pageSize"
          :total="total"
          @update:model-value="load"
        />
      </div>
    </UCard>
  </div>
</template>
