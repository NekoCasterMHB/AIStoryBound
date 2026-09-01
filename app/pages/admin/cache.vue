<script setup lang="ts">
// /admin/cache — 缓存管理(管理后台):跨用户世界缓存(world_cache)列表。
// 相同 txt + 相同模式(full/eco)共享一份成书,此页用于排查缓存命中问题、查看拉取次数与清理条目。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 缓存管理' })

const toast = useToast()

interface CacheRow {
  id: string
  sourceHash: string
  mode: 'full' | 'eco'
  fileSize: number
  title: string | null
  author: string | null
  worldKey: string
  tokensUsed: number
  downloads: number
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

interface CachePage {
  rows: CacheRow[]
  total: number
  page: number
  pageSize: number
  sort: string
  dir: 'asc' | 'desc'
  q: string
  mode: 'full' | 'eco' | undefined
  stats: { totalCache: number, totalDownloads: number, totalTokens: number }
}

const rows = ref<CacheRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const q = ref('')
const modeFilter = ref('')
const stats = ref<CachePage['stats'] | null>(null)

async function load(p = page.value) {
  loading.value = true
  try {
    const params = new URLSearchParams({ page: String(p), pageSize: String(pageSize) })
    if (q.value.trim()) params.set('q', q.value.trim())
    if (modeFilter.value) params.set('mode', modeFilter.value)
    const data = await $fetch<CachePage>(`/api/admin/cache?${params}`)
    rows.value = data.rows
    total.value = data.total
    page.value = data.page
    stats.value = data.stats
  } catch (e) {
    toast.add({ title: '加载缓存列表失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

function search() {
  page.value = 1
  void load(1)
}

function pickMode(m: string) {
  modeFilter.value = m
  page.value = 1
  void load(1)
}

function fmtTs(ts: number) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function fmtBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(n / 1024))}KB`
}

function fmtHash(hash: string) {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash
}

// ---- 删除(单条) ----
const deletingId = ref<string | null>(null)
const deleteOpen = ref(false)
const deleteRow = ref<CacheRow | null>(null)

function openDelete(row: CacheRow) {
  deleteRow.value = row
  deleteOpen.value = true
}

async function submitDelete() {
  const row = deleteRow.value
  if (!row) return
  deletingId.value = row.id
  try {
    await $fetch(`/api/admin/cache/${row.id}`, { method: 'DELETE' })
    toast.add({ title: `已删除缓存「${row.title ?? '未命名'}」`, color: 'success' })
    deleteOpen.value = false
    // 当前页删空则回退一页
    if (rows.value.length === 1 && page.value > 1) page.value -= 1
    void load(page.value)
  } catch (e) {
    toast.add({ title: '删除失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    deletingId.value = null
  }
}

// ---- 下载(单条成书 zip) ----
function download(row: CacheRow) {
  // 鉴权由接口内部完成(requireAdmin);浏览器直接打开触发附件下载
  window.open(`/api/admin/cache/${row.id}/download`, '_blank')
}

// ---- 添加到推荐书架(预置小说) ----
const promotingId = ref<string | null>(null)

async function promote(row: CacheRow) {
  promotingId.value = row.id
  try {
    const res = await $fetch<{ ok: boolean, presetId: string, title: string | null }>(`/api/admin/cache/${row.id}/promote`, { method: 'POST' })
    toast.add({
      title: `已加入推荐书架「${res.title ?? '未命名'}」`,
      description: '用户可在书架「推荐书架」标签下直接进入/生成',
      color: 'success'
    })
  } catch (e) {
    toast.add({ title: '加入推荐书架失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    promotingId.value = null
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5">
      <h1 class="text-xl font-semibold">
        缓存管理
      </h1>
      <p class="text-sm text-neutral-500">
        跨用户世界缓存:相同 txt + 相同模式共享一份成书,拉取扣记录消耗的一半;此页查看与清理缓存条目
      </p>
    </div>

    <!-- 汇总统计 -->
    <div class="mb-4 grid gap-3 sm:grid-cols-3">
      <UCard>
        <p class="text-xs text-neutral-500">
          缓存总数
        </p>
        <p class="text-xl font-bold tabular-nums">
          {{ stats?.totalCache ?? '—' }}
        </p>
      </UCard>
      <UCard>
        <p class="text-xs text-neutral-500">
          累计拉取次数
        </p>
        <p class="text-xl font-bold tabular-nums">
          {{ stats?.totalDownloads?.toLocaleString() ?? '—' }}
        </p>
      </UCard>
      <UCard>
        <p class="text-xs text-neutral-500">
          成书总消耗(tokens)
        </p>
        <p class="text-xl font-bold tabular-nums">
          {{ stats?.totalTokens?.toLocaleString() ?? '—' }}
        </p>
      </UCard>
    </div>

    <!-- 搜索 + 模式筛选 -->
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <UInput
        v-model="q"
        class="w-64"
        placeholder="按标题 / 作者 / 特征码搜索"
        icon="i-lucide-search"
        :disabled="loading"
        @keyup.enter="search"
      />
      <UButton
        color="primary"
        size="sm"
        icon="i-lucide-search"
        :loading="loading"
        @click="search"
      >
        搜索
      </UButton>
      <UButton
        size="sm"
        variant="ghost"
        icon="i-lucide-x"
        @click="q = ''; search()"
      >
        清空
      </UButton>
      <div class="ms-2 flex items-center gap-2">
        <UButton
          :color="modeFilter === '' ? 'primary' : 'neutral'"
          :variant="modeFilter === '' ? 'solid' : 'outline'"
          size="sm"
          @click="pickMode('')"
        >
          全部
        </UButton>
        <UButton
          :color="modeFilter === 'full' ? 'primary' : 'neutral'"
          :variant="modeFilter === 'full' ? 'solid' : 'outline'"
          size="sm"
          @click="pickMode('full')"
        >
          full
        </UButton>
        <UButton
          :color="modeFilter === 'eco' ? 'primary' : 'neutral'"
          :variant="modeFilter === 'eco' ? 'solid' : 'outline'"
          size="sm"
          @click="pickMode('eco')"
        >
          eco
        </UButton>
      </div>
    </div>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                标题 / 特征码
              </th>
              <th class="py-2 pr-3 font-medium">
                模式
              </th>
              <th class="py-2 pr-3 font-medium">
                大小
              </th>
              <th class="py-2 pr-3 font-medium">
                消耗 tokens
              </th>
              <th class="py-2 pr-3 font-medium">
                拉取次数
              </th>
              <th class="py-2 pr-3 font-medium">
                创建人
              </th>
              <th class="py-2 pr-3 font-medium">
                更新时间
              </th>
              <th class="py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td
                colspan="8"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="8"
                class="py-6 text-center text-neutral-500"
              >
                暂无缓存记录
              </td>
            </tr>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="max-w-72 py-2.5 pr-3">
                <p class="truncate font-medium">
                  {{ r.title || '未命名' }}
                </p>
                <p class="truncate text-xs text-neutral-400">
                  {{ fmtHash(r.sourceHash) }}
                </p>
              </td>
              <td class="py-2.5 pr-3">
                <UBadge
                  size="sm"
                  :color="r.mode === 'full' ? 'primary' : 'warning'"
                  variant="soft"
                >
                  {{ r.mode === 'full' ? '完整' : '节约' }}
                </UBadge>
              </td>
              <td class="py-2.5 pr-3 text-xs tabular-nums text-neutral-500">
                {{ fmtBytes(r.fileSize) }}
              </td>
              <td class="py-2.5 pr-3 tabular-nums">
                {{ r.tokensUsed.toLocaleString() }}
              </td>
              <td class="py-2.5 pr-3 tabular-nums">
                {{ r.downloads.toLocaleString() }}
              </td>
              <td class="max-w-32 truncate py-2.5 pr-3 text-xs text-neutral-500">
                {{ r.author || '—' }}
              </td>
              <td class="py-2.5 pr-3 text-xs text-neutral-500">
                {{ fmtTs(r.updatedAt) }}
              </td>
              <td class="py-2.5">
                <div class="flex flex-wrap gap-1">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-download"
                    @click="download(r)"
                  >
                    下载
                  </UButton>
                  <UButton
                    size="xs"
                    color="primary"
                    variant="soft"
                    icon="i-lucide-book-plus"
                    :loading="promotingId === r.id"
                    @click="promote(r)"
                  >
                    推荐书架
                  </UButton>
                  <UButton
                    size="xs"
                    color="error"
                    variant="soft"
                    icon="i-lucide-trash-2"
                    :loading="deletingId === r.id"
                    @click="openDelete(r)"
                  >
                    删除
                  </UButton>
                </div>
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
          v-model:page="page"
          :items-per-page="pageSize"
          :total="total"
          show-edges
          @update:page="load"
        />
      </div>
      <p
        v-else-if="total > 0"
        class="mt-3 text-xs text-neutral-400"
      >
        共 {{ total.toLocaleString() }} 条缓存
      </p>
    </UCard>

    <!-- 删除确认 -->
    <UModal
      v-model:open="deleteOpen"
      :title="`删除缓存「${deleteRow?.title ?? '未命名'}」`"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          将删除该缓存记录及对应成书文件。删除后相同内容的 txt 需重新生成才能拉取,且历史拉取记录不受影响。确认删除?
        </p>
        <div class="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:bg-neutral-900/40">
          特征码 {{ deleteRow ? fmtHash(deleteRow.sourceHash) : '—' }} · 模式 {{ deleteRow?.mode }} · 拉取 {{ deleteRow?.downloads.toLocaleString() }} 次
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="deleteOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="error"
            :loading="deletingId !== null"
            @click="submitDelete"
          >
            确认删除
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
