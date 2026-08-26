<script setup lang="ts">
import { parseMarkdown } from '@nuxtjs/mdc/runtime'
import { SKILL_STATUS_LABELS } from '#shared/store-skill'
import type { SkillStatus } from '#shared/store-skill'

// /admin/skills — Skill 审核(管理后台):商品列表 + 下载审核 + 通过/拒绝 + 推荐标记。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · Skill 审核' })

const toast = useToast()

interface SkillFileEntry {
  name: string
  size: number
  isDirectory: boolean
}
interface SkillRow {
  id: string
  /** 最新提交版本号 */
  version: number
  name: string
  desc: string
  price: number
  status: SkillStatus
  rejectReason: string | null
  featured: number
  downloadCount: number
  purchaseCount: number
  fileSize: number
  fileEntries: SkillFileEntry[]
  sellerName: string
  sellerEmail: string
  createdAt: number
  reviewedAt: number | null
}

const STATUS_COLORS: Record<SkillStatus, string> = {
  pending: 'text-amber-600',
  approved: 'text-emerald-600',
  rejected: 'text-red-500',
  removed: 'text-neutral-400'
}

const rows = ref<SkillRow[]>([])
const loading = ref(false)
const statusFilter = ref('')

const counts = ref<Record<string, number>>({})

async function load() {
  loading.value = true
  try {
    const query = statusFilter.value ? `?status=${statusFilter.value}` : ''
    const list = await $fetch<SkillRow[]>(`/api/admin/skills${query}`)
    rows.value = list
    // 计数:再拉一次全量统计(轻量;列表本身按筛选返回)
    const all = await $fetch<SkillRow[]>('/api/admin/skills')
    counts.value = all.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
  } catch (e) {
    toast.add({ title: '加载 Skill 列表失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => { void load() })

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

function downloadReview(row: SkillRow) {
  // 管理员鉴权由下载接口内部完成(requireUser + isAdmin)
  window.open(`/api/store/skills/${row.id}/download`, '_blank')
}

async function approve(row: SkillRow) {
  try {
    await $fetch(`/api/admin/skills/${row.id}/review`, {
      method: 'POST',
      body: { status: 'approved' }
    })
    toast.add({ title: `已通过「${row.name}」,将在商城展示`, color: 'success' })
    void load()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 拒绝(需填写原因) ----
const rejectOpen = ref(false)
const rejectRow = ref<SkillRow | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

function openReject(row: SkillRow) {
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
    await $fetch(`/api/admin/skills/${rejectRow.value.id}/review`, {
      method: 'POST',
      body: { status: 'rejected', reason: rejectReason.value }
    })
    toast.add({ title: '已拒绝该 Skill', color: 'success' })
    rejectOpen.value = false
    void load()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    rejecting.value = false
  }
}

// ---- 推荐标记 ----
async function toggleFeatured(row: SkillRow) {
  try {
    await $fetch(`/api/admin/skills/${row.id}/review`, {
      method: 'POST',
      body: { featured: row.featured === 0 }
    })
    toast.add({ title: row.featured === 0 ? '已标记「平台推荐」' : '已取消推荐', color: 'success' })
    void load()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 文件清单预览 ----
const entriesOpen = ref(false)
const entriesRow = ref<SkillRow | null>(null)

// ---- 在线预览 markdown ----
type MarkdownBody = Awaited<ReturnType<typeof parseMarkdown>>['body']
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const previewFiles = ref<{ name: string, content: string }[]>([])
const previewIdx = ref(0)
const previewAst = ref<MarkdownBody | null>(null)

function isMdFile(name: string) {
  return /\.(md|markdown)$/i.test(name)
}

async function openPreview(row: SkillRow | null) {
  if (!row) return
  previewOpen.value = true
  previewLoading.value = true
  previewError.value = ''
  previewFiles.value = []
  previewAst.value = null
  try {
    const res = await $fetch<{ files: { name: string, content: string }[] }>(`/api/admin/skills/${row.id}/preview`)
    previewFiles.value = res.files
    if (res.files.length) {
      await renderPreview(0)
    }
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

async function renderPreview(i: number) {
  previewIdx.value = i
  previewAst.value = null
  previewError.value = ''
  const content = previewFiles.value[i]?.content ?? ''
  try {
    const { body } = await parseMarkdown(content)
    previewAst.value = body
  } catch {
    previewError.value = 'Markdown 解析失败'
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5">
      <h1 class="text-xl font-semibold">
        Skill 审核
      </h1>
      <p class="text-sm text-neutral-500">
        审核通过后商品在 Skill 商城上架;可下载压缩包核对内容,对优质 skill 可打「平台推荐」标
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
        v-for="s in (['pending', 'approved', 'rejected', 'removed'] as SkillStatus[])"
        :key="s"
        :color="statusFilter === s ? 'primary' : 'neutral'"
        :variant="statusFilter === s ? 'solid' : 'outline'"
        size="sm"
        @click="pickStatus(s)"
      >
        {{ SKILL_STATUS_LABELS[s] }} {{ counts[s] ?? 0 }}
      </UButton>
    </div>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                Skill
              </th>
              <th class="py-2 pr-3 font-medium">
                发布者
              </th>
              <th class="py-2 pr-3 font-medium">
                售价
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
              <td colspan="7" class="py-6 text-center text-neutral-500">
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td colspan="7" class="py-6 text-center text-neutral-500">
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
                  {{ r.name }}
                  <UBadge size="sm" variant="subtle">
                    v{{ r.version }}
                  </UBadge>
                  <UBadge v-if="r.featured === 1" color="primary" size="sm">
                    推荐
                  </UBadge>
                </p>
                <p class="line-clamp-2 text-xs text-neutral-500">
                  {{ r.desc }}
                </p>
                <p class="mt-0.5 text-xs text-neutral-400">
                  {{ fmtBytes(r.fileSize) }} · {{ r.fileEntries.length }} 个文件
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
              <td class="py-2.5 pr-3">
                <p :class="STATUS_COLORS[r.status]">
                  {{ SKILL_STATUS_LABELS[r.status] }}
                </p>
                <p v-if="r.status === 'rejected' && r.rejectReason" class="max-w-40 truncate text-xs text-red-400/80">
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
                    variant="soft"
                    icon="i-lucide-folder-open"
                    @click="entriesRow = r; entriesOpen = true"
                  >
                    文件
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
                    :icon="r.featured === 1 ? 'i-lucide-star' : 'i-lucide-star'"
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
    <UModal v-model:open="rejectOpen" :title="`拒绝「${rejectRow?.name ?? ''}」`">
      <template #body>
        <UFormField label="拒绝原因(将展示给发布者)" required>
          <UTextarea v-model="rejectReason" :rows="3" autoresize :maxrows="8" class="w-full" placeholder="如:压缩包缺 SKILL.md / 内容与描述不符" />
        </UFormField>
        <div class="mt-4 flex justify-end gap-2">
          <UButton color="neutral" variant="outline" @click="rejectOpen = false">
            取消
          </UButton>
          <UButton color="error" :loading="rejecting" @click="submitReject">
            确认拒绝
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 文件清单弹窗 -->
    <UModal v-model:open="entriesOpen" :title="`文件清单 · ${entriesRow?.name ?? ''}`">
      <template #body>
        <p v-if="!entriesRow?.fileEntries.length" class="py-4 text-center text-sm text-neutral-500">
          无文件清单
        </p>
        <ul v-else class="max-h-80 divide-y divide-neutral-100 overflow-y-auto font-mono text-xs dark:divide-neutral-900">
          <li
            v-for="e in entriesRow.fileEntries"
            :key="e.name"
            class="flex items-center justify-between gap-3 py-1.5"
          >
            <span class="truncate" :class="e.isDirectory ? 'text-neutral-400' : ''">
              {{ e.isDirectory ? '📁' : '📄' }} {{ e.name }}
            </span>
            <span class="flex shrink-0 items-center gap-2">
              <span v-if="!e.isDirectory" class="text-neutral-500">
                {{ e.size.toLocaleString() }} B
              </span>
              <UButton
                v-if="!e.isDirectory && isMdFile(e.name)"
                color="primary"
                variant="soft"
                size="xs"
                icon="i-lucide-eye"
                @click="openPreview(entriesRow)"
              >
                预览
              </UButton>
            </span>
          </li>
        </ul>
      </template>
    </UModal>

    <!-- 在线预览弹窗 -->
    <UModal
      v-model:open="previewOpen"
      title="在线预览"
      :ui="{
        content: 'max-w-3xl'
      }"
    >
      <template #body>
        <p v-if="previewLoading" class="py-6 text-center text-sm text-neutral-500">
          加载中…
        </p>
        <p v-else-if="previewError" class="py-6 text-center text-sm text-red-500">
          {{ previewError }}
        </p>
        <div v-else-if="previewFiles.length" class="grid grid-cols-[170px_1fr] gap-4">
          <ul class="max-h-[65vh] divide-y divide-neutral-100 overflow-y-auto font-mono text-xs dark:divide-neutral-900">
            <li v-for="(f, i) in previewFiles" :key="f.name">
              <button
                type="button"
                class="w-full truncate px-2 py-1.5 text-left transition-colors"
                :class="i === previewIdx
                  ? 'bg-primary/10 text-primary'
                  : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900'"
                @click="renderPreview(i)"
              >
                {{ f.name }}
              </button>
            </li>
          </ul>
          <article class="md-preview max-h-[65vh] overflow-y-auto pr-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            <MDCRenderer v-if="previewAst" :body="previewAst" />
          </article>
        </div>
        <p v-else class="py-6 text-center text-sm text-neutral-500">
          压缩包内没有 markdown 文件
        </p>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* markdown 预览排版(无 typography 插件,MDRenderer 渲染的标签无 data-v,用 :deep 覆盖) */
.md-preview :deep(h1), .md-preview :deep(h2), .md-preview :deep(h3), .md-preview :deep(h4) {
  margin: 0.875rem 0 0.5rem;
  font-weight: 700;
  color: var(--ui-text-highlighted);
}
.md-preview :deep(h1) {
  font-size: 1.125rem;
}
.md-preview :deep(h2) {
  font-size: 1rem;
}
.md-preview :deep(h3) {
  font-size: 0.9375rem;
}
.md-preview :deep(h4) {
  font-size: 0.875rem;
}
.md-preview :deep(:first-child) {
  margin-top: 0;
}
.md-preview :deep(p) {
  margin: 0.375rem 0;
}
.md-preview :deep(ul), .md-preview :deep(ol) {
  margin: 0.375rem 0;
  padding-left: 1.375rem;
}
.md-preview :deep(ul) {
  list-style: disc;
}
.md-preview :deep(ol) {
  list-style: decimal;
}
.md-preview :deep(li) {
  margin: 0.25rem 0;
}
.md-preview :deep(li > input[type='checkbox']) {
  margin-right: 0.375rem;
}
.md-preview :deep(a) {
  color: var(--ui-primary);
  text-decoration: underline;
}
.md-preview :deep(code) {
  border-radius: 0.25rem;
  background: var(--ui-bg-muted);
  padding: 0.125rem 0.3125rem;
  font-size: 0.8125em;
}
.md-preview :deep(pre) {
  margin: 0.5rem 0;
  overflow-x: auto;
  border-radius: 0.5rem;
  background: var(--ui-bg-muted);
  padding: 0.75rem;
  font-size: 0.75rem;
  line-height: 1.6;
}
.md-preview :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}
.md-preview :deep(blockquote) {
  margin: 0.5rem 0;
  border-left: 3px solid var(--ui-border);
  padding-left: 0.75rem;
  color: var(--ui-text-muted);
}
.md-preview :deep(hr) {
  margin: 0.875rem 0;
  border: none;
  border-top: 1px solid var(--ui-border);
}
.md-preview :deep(table) {
  margin: 0.5rem 0;
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.md-preview :deep(th), .md-preview :deep(td) {
  border: 1px solid var(--ui-border);
  padding: 0.3125rem 0.5rem;
}
.md-preview :deep(th) {
  background: var(--ui-bg-muted);
  font-weight: 600;
}
.md-preview :deep(img) {
  max-width: 100%;
  border-radius: 0.5rem;
}
</style>