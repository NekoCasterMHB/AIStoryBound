<script setup lang="ts">
import { NOVEL_STATUS_LABELS, fmtNovelChars } from '#shared/store-novel'
import type { NovelStatus } from '#shared/store-novel'

// /admin/novels — 小说审核(管理后台):商品列表 + 试读/下载审核 + 通过/拒绝 + 推荐标记。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 小说审核' })

const toast = useToast()

interface NovelRow {
  id: string
  /** 最新提交版本号 */
  version: number
  title: string
  author: string | null
  desc: string
  price: number
  previewChars: number
  totalChars: number
  status: NovelStatus
  rejectReason: string | null
  featured: number
  downloadCount: number
  purchaseCount: number
  fileSize: number
  sellerName: string
  sellerEmail: string
  createdAt: number
  reviewedAt: number | null
}

const STATUS_COLORS: Record<NovelStatus, string> = {
  pending: 'text-amber-600',
  approved: 'text-emerald-600',
  rejected: 'text-red-500',
  removed: 'text-neutral-400'
}

const rows = ref<NovelRow[]>([])
const loading = ref(false)
const statusFilter = ref('')

const counts = ref<Record<string, number>>({})

async function load() {
  loading.value = true
  try {
    const query = statusFilter.value ? `?status=${statusFilter.value}` : ''
    const list = await $fetch<NovelRow[]>(`/api/admin/novels${query}`)
    rows.value = list
    // 计数:再拉一次全量统计(轻量;列表本身按筛选返回)
    const all = await $fetch<NovelRow[]>('/api/admin/novels')
    counts.value = all.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
  } catch (e) {
    toast.add({ title: '加载小说列表失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

function pickStatus(s: string) {
  statusFilter.value = s
  void load()
}

function fmtTs(ts: number | null) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function fmtBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(n / 1024))}KB`
}

function downloadReview(row: NovelRow) {
  // 管理员鉴权由下载接口内部完成(requireUser + isAdmin)
  window.open(`/api/store/novels/${row.id}/download`, '_blank')
}

async function approve(row: NovelRow) {
  try {
    await $fetch(`/api/admin/novels/${row.id}/review`, {
      method: 'POST',
      body: { status: 'approved' }
    })
    toast.add({ title: `已通过「${row.title}」,将在书架商城展示`, color: 'success' })
    void load()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 拒绝(需填写原因) ----
const rejectOpen = ref(false)
const rejectRow = ref<NovelRow | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

function openReject(row: NovelRow) {
  rejectRow.value = row
  rejectReason.value = ''
  rejectOpen.value = true
}

async function submitReject() {
  if (!rejectRow.value) return
  if (!rejectReason.value.trim()) {
    toast.add({ title: '请填写拒绝原因,将展示给发布者', color: 'error' })
    return
  }
  rejecting.value = true
  try {
    await $fetch(`/api/admin/novels/${rejectRow.value.id}/review`, {
      method: 'POST',
      body: { status: 'rejected', reason: rejectReason.value }
    })
    toast.add({ title: '已拒绝该小说', color: 'success' })
    rejectOpen.value = false
    void load()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    rejecting.value = false
  }
}

// ---- 推荐标记 ----
async function toggleFeatured(row: NovelRow) {
  try {
    await $fetch(`/api/admin/novels/${row.id}/review`, {
      method: 'POST',
      body: { featured: row.featured === 0 }
    })
    toast.add({ title: row.featured === 0 ? '已标记「平台推荐」' : '已取消推荐', color: 'success' })
    void load()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 在线试读(审核):最新提交版本元信息 + 正文前 MAX_NOVEL_REVIEW_BYTES 字节 ----
interface NovelPreviewData {
  version: number
  title: string
  author: string | null
  desc: string
  price: number
  previewChars: number
  totalChars: number
  fileSize: number
  status: NovelStatus
  rejectReason: string | null
  /** 正文前 50KB 解码后的文本(超长截断) */
  content: string
  truncated: boolean
}
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const previewData = ref<NovelPreviewData | null>(null)

async function openPreview(row: NovelRow | null) {
  if (!row) return
  previewOpen.value = true
  previewLoading.value = true
  previewError.value = ''
  previewData.value = null
  try {
    previewData.value = await $fetch<NovelPreviewData>(`/api/admin/novels/${row.id}/preview`)
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5">
      <h1 class="text-xl font-semibold">
        小说审核
      </h1>
      <p class="text-sm text-neutral-500">
        审核通过后小说在创意工坊「书架」上架;可在线试读正文开头或下载整本核对,对优质小说可打「平台推荐」标
      </p>
    </div>

    <!-- 状态筛选 -->
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <UButton
        :color="statusFilter === '' ? 'primary' : 'neutral'"
        :variant="statusFilter === '' ? 'solid' : 'outline'"
        size="sm"
        @click="pickStatus('')"
      >
        全部 {{ Object.values(counts).reduce((s, n) => s + n, 0) }}
      </UButton>
      <UButton
        v-for="s in (['pending', 'approved', 'rejected', 'removed'] as NovelStatus[])"
        :key="s"
        :color="statusFilter === s ? 'primary' : 'neutral'"
        :variant="statusFilter === s ? 'solid' : 'outline'"
        size="sm"
        @click="pickStatus(s)"
      >
        {{ NOVEL_STATUS_LABELS[s] }} {{ counts[s] ?? 0 }}
      </UButton>
    </div>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                小说
              </th>
              <th class="py-2 pr-3 font-medium">
                发布者
              </th>
              <th class="py-2 pr-3 font-medium">
                售价
              </th>
              <th class="py-2 pr-3 font-medium">
                试读字数
              </th>
              <th class="py-2 pr-3 font-medium">
                状态
              </th>
              <th class="py-2 pr-3 font-medium">
                数据
              </th>
              <th class="py-2 pr-3 font-medium">
                提交时间
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
                暂无待处理项
              </td>
            </tr>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="max-w-60 py-2.5 pr-3">
                <p class="flex items-center gap-1.5 truncate font-medium">
                  {{ r.title }}
                  <UBadge
                    size="sm"
                    variant="subtle"
                  >
                    v{{ r.version }}
                  </UBadge>
                  <UBadge
                    v-if="r.featured === 1"
                    color="primary"
                    size="sm"
                  >
                    推荐
                  </UBadge>
                </p>
                <p class="truncate text-xs text-neutral-500">
                  作者: {{ r.author || '佚名' }}
                </p>
                <p class="line-clamp-1 text-xs text-neutral-400">
                  {{ r.desc }}
                </p>
                <p class="mt-0.5 text-xs text-neutral-400">
                  {{ fmtBytes(r.fileSize) }} · 全书 {{ fmtNovelChars(r.totalChars) }}
                </p>
              </td>
              <td class="max-w-40 py-2.5 pr-3">
                <p class="truncate">
                  {{ r.sellerName }}
                </p>
                <p class="truncate text-xs text-neutral-500">
                  {{ r.sellerEmail }}
                </p>
              </td>
              <td class="py-2.5 pr-3 tabular-nums">
                {{ r.price > 0 ? r.price.toLocaleString() : '免费' }}
              </td>
              <td class="py-2.5 pr-3 tabular-nums">
                {{ r.previewChars > 0 ? `${r.previewChars.toLocaleString()} 字` : '不可试读' }}
              </td>
              <td class="py-2.5 pr-3">
                <p :class="STATUS_COLORS[r.status]">
                  {{ NOVEL_STATUS_LABELS[r.status] }}
                </p>
                <p
                  v-if="r.status === 'rejected' && r.rejectReason"
                  class="max-w-40 truncate text-xs text-red-400/80"
                >
                  原因:{{ r.rejectReason }}
                </p>
              </td>
              <td class="py-2.5 pr-3 text-xs tabular-nums text-neutral-500">
                <p>
                  下载 {{ r.downloadCount }}
                </p>
                <p>
                  购买 {{ r.purchaseCount }}
                </p>
              </td>
              <td class="py-2.5 pr-3">
                {{ fmtTs(r.createdAt) }}
              </td>
              <td class="py-2.5">
                <div class="flex flex-wrap gap-1">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-book-open"
                    @click="openPreview(r)"
                  >
                    试读
                  </UButton>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-download"
                    @click="downloadReview(r)"
                  >
                    下载审核
                  </UButton>
                  <UButton
                    v-if="r.status !== 'approved'"
                    size="xs"
                    color="success"
                    variant="soft"
                    icon="i-lucide-check"
                    @click="approve(r)"
                  >
                    通过
                  </UButton>
                  <UButton
                    v-if="r.status !== 'rejected'"
                    size="xs"
                    color="error"
                    variant="soft"
                    icon="i-lucide-x"
                    @click="openReject(r)"
                  >
                    拒绝
                  </UButton>
                  <UButton
                    size="xs"
                    :color="r.featured === 1 ? 'primary' : 'neutral'"
                    :variant="r.featured === 1 ? 'solid' : 'outline'"
                    icon="i-lucide-star"
                    @click="toggleFeatured(r)"
                  >
                    {{ r.featured === 1 ? '已推荐' : '推荐' }}
                  </UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- 拒绝弹窗 -->
    <UModal
      v-model:open="rejectOpen"
      :title="`拒绝「${rejectRow?.title ?? ''}」`"
    >
      <template #body>
        <UFormField
          label="拒绝原因(将展示给发布者)"
          required
        >
          <UTextarea
            v-model="rejectReason"
            :rows="3"
            autoresize
            :maxrows="8"
            class="w-full"
            placeholder="如:内容与简介不符 / 篇幅过短 / 涉嫌抄袭"
          />
        </UFormField>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="rejectOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="error"
            :loading="rejecting"
            @click="submitReject"
          >
            确认拒绝
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 在线试读弹窗 -->
    <UModal
      v-model:open="previewOpen"
      title="在线试读"
      :ui="{
        content: 'max-w-3xl'
      }"
    >
      <template #body>
        <p
          v-if="previewLoading"
          class="py-6 text-center text-sm text-neutral-500"
        >
          加载中…
        </p>
        <p
          v-else-if="previewError"
          class="py-6 text-center text-sm text-red-500"
        >
          {{ previewError }}
        </p>
        <template v-else-if="previewData">
          <div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span>v{{ previewData.version }}</span>
            <span>·</span>
            <span>作者: {{ previewData.author || '佚名' }}</span>
            <span>·</span>
            <span>全书 {{ fmtNovelChars(previewData.totalChars) }}</span>
            <span>·</span>
            <span v-if="previewData.price > 0">
              售价 {{ previewData.price.toLocaleString() }} tokens
            </span>
            <span v-else>免费</span>
            <span>·</span>
            <span>发布者开放试读 {{ previewData.previewChars > 0 ? `${previewData.previewChars.toLocaleString()} 字` : '不可试读' }}</span>
          </div>
          <div class="max-h-[60vh] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/40">
            <p class="whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
              {{ previewData.content }}
            </p>
          </div>
          <p
            v-if="previewData.truncated"
            class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
          >
            正文较长,仅展示开头部分;请点击「下载审核」下载整本核对
          </p>
        </template>
      </template>
    </UModal>
  </div>
</template>
