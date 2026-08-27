<script setup lang="ts">
import { parseMarkdown } from '@nuxtjs/mdc/runtime'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { SKILL_STATUS_LABELS, extractSkillMeta, MAX_SKILL_ZIP_BYTES } from '#shared/store-skill'
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

// ---- 直接发布(上传 zip + 在线编辑 md + 重新打包直接上架) ----
const publishOpen = ref(false)
const publishing = ref(false)
const pubZipFiles = ref<Record<string, Uint8Array>>({})
const pubFileNames = ref<string[]>([])
const pubEditFile = ref('')
const pubFileTexts = ref<Record<string, string>>({})
const pubName = ref('')
const pubPrice = ref('0')
const pubTags = ref<string[]>([])
const pubIcon = ref('')
const pubFileName = ref('')

function openPublish() {
  publishOpen.value = true
  publishError.value = ''
  pubZipFiles.value = {}
  pubFileNames.value = []
  pubEditFile.value = ''
  pubFileTexts.value = {}
  pubName.value = ''
  pubPrice.value = '0'
  pubTags.value = []
  pubIcon.value = ''
  pubFileName.value = ''
}

const publishError = ref('')

/** 从 SKILL.md frontmatter 提取 name(展示名兜底,可手动改) */
function frontmatterName(md: string): string {
  const m = /^name:\s*(.+)$/m.exec(md)
  return m?.[1]?.trim() ?? ''
}

async function onPickPubZip(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  publishError.value = ''
  if (file.size > MAX_SKILL_ZIP_BYTES) {
    publishError.value = `压缩包超过 ${MAX_SKILL_ZIP_BYTES / 1024 / 1024}MB 上限`
    return
  }
  try {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()))
    pubZipFiles.value = files
    pubFileNames.value = Object.keys(files).filter(n => !n.endsWith('/'))
    const texts: Record<string, string> = {}
    for (const [name, b] of Object.entries(files)) {
      if (name.endsWith('/')) continue
      texts[name] = strFromU8(b)
    }
    pubFileTexts.value = texts
    pubFileName.value = file.name
    const skillMdName = pubFileNames.value.find(n => /SKILL\.md$/i.test(n))
    if (!skillMdName) {
      publishError.value = '压缩包内未找到 SKILL.md,请按标准 agent skill 格式打包'
      return
    }
    pubEditFile.value = skillMdName
    const { icon, tags } = extractSkillMeta(texts[skillMdName] ?? '', null)
    pubIcon.value = icon ?? ''
    pubTags.value = tags
    pubName.value = frontmatterName(texts[skillMdName] ?? '') || file.name.replace(/\.zip$/i, '')
  } catch {
    publishError.value = '无法解析 zip 压缩包'
  }
}

function isCoreFile(name: string) {
  return /SKILL\.md$/i.test(name) || /^README(\.md)?$/i.test(name)
}

async function submitPublish() {
  if (!Object.keys(pubZipFiles.value).length) {
    publishError.value = '请先选择 zip 压缩包'
    return
  }
  if (!pubName.value.trim()) {
    publishError.value = '请填写 Skill 名称'
    return
  }
  publishing.value = true
  publishError.value = ''
  try {
    // 回填编辑内容并重新打包(未编辑文件保留原字节)
    const out: Record<string, Uint8Array> = {}
    for (const [name, b] of Object.entries(pubZipFiles.value)) {
      if (name.endsWith('/')) continue
      const text = pubFileTexts.value[name]
      out[name] = text !== undefined ? strToU8(text) : b
    }
    const zipped = zipSync(out, { level: 6 })
    const fd = new FormData()
    fd.append('name', pubName.value.trim())
    fd.append('price', pubPrice.value || '0')
    fd.append('tags', JSON.stringify(pubTags.value))
    fd.append('file', new Blob([zipped], { type: 'application/zip' }), pubFileName.value || 'skill.zip')
    const res = await $fetch<{ id: string, version: number }>('/api/admin/skills/publish', {
      method: 'POST',
      body: fd
    })
    toast.add({ title: `已直接上架「${pubName.value.trim()}」 v${res.version}`, color: 'success' })
    publishOpen.value = false
    void load()
  } catch (e) {
    publishError.value = e instanceof Error ? e.message : String(e)
  } finally {
    publishing.value = false
  }
}

// ---- 制作指导(展示 skill-guide.md:如何制作适合本项目的 Skill) ----
const guideOpen = ref(false)
const guideLoading = ref(false)
const guideError = ref('')
const guideAst = ref<MarkdownBody | null>(null)

async function openGuide() {
  guideOpen.value = true
  guideLoading.value = true
  guideError.value = ''
  guideAst.value = null
  try {
    const md = await $fetch<string>('/skill-guide.md', { responseType: 'text' })
    const { body } = await parseMarkdown(md)
    guideAst.value = body
  } catch {
    guideError.value = '指导文档加载失败'
  } finally {
    guideLoading.value = false
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
        审核通过后商品在创意工坊「Skill包」上架;可下载压缩包核对内容,对优质 skill 可打「平台推荐」标
      </p>
    </div>

    <!-- 状态筛选 -->
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <UButton
        color="primary"
        variant="solid"
        icon="i-lucide-upload"
        class="mr-2"
        @click="openPublish"
      >
        发布技能
      </UButton>
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
              <td
                colspan="7"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="7"
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
                  {{ r.name }}
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
    <UModal
      v-model:open="rejectOpen"
      :title="`拒绝「${rejectRow?.name ?? ''}」`"
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
            placeholder="如:压缩包缺 SKILL.md 或 README / 内容与描述不符"
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

    <!-- 文件清单弹窗 -->
    <UModal
      v-model:open="entriesOpen"
      :title="`文件清单 · ${entriesRow?.name ?? ''}`"
    >
      <template #body>
        <p
          v-if="!entriesRow?.fileEntries.length"
          class="py-4 text-center text-sm text-neutral-500"
        >
          无文件清单
        </p>
        <ul
          v-else
          class="max-h-80 divide-y divide-neutral-100 overflow-y-auto font-mono text-xs dark:divide-neutral-900"
        >
          <li
            v-for="e in entriesRow.fileEntries"
            :key="e.name"
            class="flex items-center justify-between gap-3 py-1.5"
          >
            <span
              class="truncate"
              :class="e.isDirectory ? 'text-neutral-400' : ''"
            >
              {{ e.isDirectory ? '📁' : '📄' }} {{ e.name }}
            </span>
            <span class="flex shrink-0 items-center gap-2">
              <span
                v-if="!e.isDirectory"
                class="text-neutral-500"
              >
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
        <div
          v-else-if="previewFiles.length"
          class="grid grid-cols-[170px_1fr] gap-4"
        >
          <ul class="max-h-[65vh] divide-y divide-neutral-100 overflow-y-auto font-mono text-xs dark:divide-neutral-900">
            <li
              v-for="(f, i) in previewFiles"
              :key="f.name"
            >
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
            <MDCRenderer
              v-if="previewAst"
              :body="previewAst"
            />
          </article>
        </div>
        <p
          v-else
          class="py-6 text-center text-sm text-neutral-500"
        >
          压缩包内没有 markdown 文件
        </p>
      </template>
    </UModal>

    <!-- 直接发布弹窗(上传 zip + 在线编辑 md + 重新打包直接上架) -->
    <UModal
      v-model:open="publishOpen"
      title="直接发布 Skill"
      :ui="{
        content: 'max-w-4xl'
      }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs text-neutral-500">
              支持上传任意合规 zip;首次制作可先查看生成指导
            </p>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-book-open"
              @click="openGuide"
            >
              如何制作 Skill
            </UButton>
          </div>
          <UFormField label="选择 zip 压缩包(须含 SKILL.md 与 README)">
            <input
              type="file"
              accept=".zip"
              class="block w-full text-sm text-neutral-500 file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary"
              @change="onPickPubZip"
            >
          </UFormField>

          <template v-if="pubFileNames.length">
            <p class="text-xs text-neutral-500">
              已解包 {{ pubFileName }}({{ pubFileNames.length }} 个文件);编辑后自动重新打包上架,未编辑文件保持原样
            </p>
            <div class="grid grid-cols-[170px_1fr] gap-4">
              <ul class="max-h-[45vh] divide-y divide-neutral-100 overflow-y-auto font-mono text-xs dark:divide-neutral-900">
                <li
                  v-for="n in pubFileNames"
                  :key="n"
                >
                  <button
                    type="button"
                    class="w-full truncate px-2 py-1.5 text-left transition-colors"
                    :class="n === pubEditFile
                      ? 'bg-primary/10 text-primary'
                      : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900'"
                    @click="pubEditFile = n"
                  >
                    <span
                      v-if="isCoreFile(n)"
                      class="mr-1"
                    >★</span>{{ n }}
                  </button>
                </li>
              </ul>
              <UTextarea
                v-model="pubFileTexts[pubEditFile]"
                class="w-full font-mono text-xs"
                :rows="18"
                autoresize
                :maxrows="24"
                :placeholder="pubEditFile ? `编辑 ${pubEditFile} 内容` : '选择左侧文件进行编辑'"
              />
            </div>
          </template>

          <div class="grid grid-cols-2 gap-4">
            <UFormField
              label="商城名称"
              required
            >
              <UInput
                v-model="pubName"
                placeholder="如:小圈·管教与情感陪伴"
              />
            </UFormField>
            <UFormField label="售价(token,0=免费)">
              <UInput
                v-model="pubPrice"
                type="number"
                min="0"
              />
            </UFormField>
            <UFormField label="展示标签(≤6 个)">
              <UInputTags
                v-model="pubTags"
                :max="6"
              />
            </UFormField>
            <UFormField label="展示图标(frontmatter 自动读取)">
              <UInput
                :model-value="pubIcon"
                disabled
                placeholder="未设置"
              />
            </UFormField>
          </div>

          <p
            v-if="publishError"
            class="text-sm text-red-500"
          >
            {{ publishError }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              @click="publishOpen = false"
            >
              取消
            </UButton>
            <UButton
              color="primary"
              :loading="publishing"
              icon="i-lucide-rocket"
              @click="submitPublish"
            >
              直接上架
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- 制作指导弹窗(展示 skill-guide.md 全文) -->
    <UModal
      v-model:open="guideOpen"
      title="如何制作 Skill"
      :ui="{
        content: 'max-w-3xl'
      }"
    >
      <template #body>
        <div class="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm text-primary">
          将本指导文档(md)直接交给 AI,即可生成更贴合本项目机制(性欲双参数 / 强度阶梯 / 注入裁剪 / 上架规范)的 Skill。
        </div>
        <div class="mb-3 flex justify-end">
          <a
            href="/skill-guide.md"
            download="skill-guide.md"
            class="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
          >
            <span class="i-lucide-download" />
            下载文档
          </a>
        </div>
        <p
          v-if="guideLoading"
          class="py-6 text-center text-sm text-neutral-500"
        >
          加载中…
        </p>
        <p
          v-else-if="guideError"
          class="py-6 text-center text-sm text-red-500"
        >
          {{ guideError }}
        </p>
        <article
          v-else-if="guideAst"
          class="md-preview max-h-[60vh] overflow-y-auto pr-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
        >
          <MDCRenderer :body="guideAst" />
        </article>
        <p
          v-else
          class="py-6 text-center text-sm text-neutral-500"
        >
          暂无内容
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
