<script setup lang="ts">
// /works — 我的书架(登录后):官方书架(预置小说,可直接生成)+ 个人书架(本地作品 + 云端作品 + 继续游戏)
import type { TabsItem } from '@nuxt/ui'
import { listWorks, getWork, saveWork, deleteWork, parseLocalNovel, parseChaptersFromText } from '../utils/worldGen'
import { listLocalGames } from '../utils/gameStore'
import { listReadingProgress } from '../utils/readingStore'
import { useAuthSession } from '../utils/auth-client'
import { type LocalWork, type PresetNovelRow, type ReadingProgress, type ChapterSegment, uuid } from '#shared/novel'

useHead({ title: 'AI StoryBound · 我的书架' })

const { data: session } = await useAuthSession()

const works = ref<LocalWork[]>([])
const games = ref<Awaited<ReturnType<typeof listLocalGames>>>([])
const cloudWorks = ref<{ id: string, title: string, chapter_count: number, created_at: string }[]>([])
const cloudLoaded = ref(false)

// ---- 阅读进度(沉浸式阅读页写入,key = src:id) ----
const readingProgress = ref<Record<string, ReadingProgress>>({})

async function loadReadingProgress() {
  const list = await listReadingProgress()
  readingProgress.value = Object.fromEntries(list.map(p => [p.key, p]))
}

function progressFor(src: 'preset' | 'work', id: string): ReadingProgress | undefined {
  return readingProgress.value[`${src}:${id}`]
}

/** 入口按钮文案:有进度且未读完 → 继续阅读;已读完 → 重新阅读;否则 → 立即阅读 */
function readBtnLabel(p: ReadingProgress | undefined) {
  if (!p) return '立即阅读'
  return p.finished ? '重新阅读' : '继续阅读'
}

/** 阅读进度徽章:null = 未读过 */
function readBadge(p: ReadingProgress | undefined): { label: string, color: 'success' | 'info' } | null {
  if (!p) return null
  return p.finished
    ? { label: '已读完', color: 'success' }
    : { label: `读到第 ${p.chapterIndex + 1} 章`, color: 'info' }
}

/** 徽章数组形态(模板 v-for 用,避免 null 类型窄化问题) */
function readBadges(p: ReadingProgress | undefined): { label: string, color: 'success' | 'info' }[] {
  const b = readBadge(p)
  return b ? [b] : []
}

// ---- 官方书架(预置小说) ----
const officialWorks = ref<PresetNovelRow[]>([])
const officialLoading = ref(false)

async function loadOfficialWorks() {
  officialLoading.value = true
  try {
    officialWorks.value = await $fetch('/api/presets').catch(() => [])
  } finally {
    officialLoading.value = false
  }
}

async function refreshLocal() {
  works.value = await listWorks()
  games.value = await listLocalGames()
}

onMounted(() => {
  void refreshLocal()
  void loadOfficialWorks()
  void loadReadingProgress()
})

// ---- 云端同步(手动) ----
async function syncWorkToCloud(work: LocalWork) {
  const res = await $fetch('/api/works', { method: 'POST', body: work }).catch(() => null)
  if (res) {
    work.syncStatus = 'synced'
    await saveWork(work)
    await refreshLocal()
  }
}

async function loadCloudWorks() {
  cloudWorks.value = await $fetch('/api/works').catch(() => [])
  cloudLoaded.value = true
}

async function restoreFromCloud(id: string) {
  const data = await $fetch<{
    id: string
    title: string
    author: string | null
    chapter_count: number
    created_at: string
    overlay: LocalWork['overlay'] | null
    entities?: LocalWork['entities']
    conflicts?: LocalWork['conflicts']
    warnings?: LocalWork['warnings']
  }>(`/api/works/${id}`).catch(() => null)
  if (!data) return
  const existing = await getWork(id)
  await saveWork({
    id: data.id,
    title: data.title,
    author: existing?.author ?? data.author ?? undefined,
    createdAt: existing?.createdAt ?? data.created_at,
    chapters: existing?.chapters ?? [],
    syncStatus: 'synced',
    entities: data.entities,
    conflicts: data.conflicts,
    warnings: data.warnings,
    overlay: data.overlay ?? undefined
  })
  await refreshLocal()
}

async function onDeleteWork(work: LocalWork) {
  await deleteWork(work.id)
  await refreshLocal()
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtChars(n?: number) {
  if (!n || n <= 0) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`
  if (n >= 1000) return `${(n / 1000).toFixed(1)} 千字`
  return `${n} 字`
}

const shelfTabs = ref<TabsItem[]>([
  { label: '个人书架', value: 'personal', slot: 'personal' },
  { label: '官方书架', value: 'official', slot: 'official' }
])
const activeTab = ref('personal')

// ---- 导入小说:上传 TXT / 粘贴文本 → 解析后直接入库(本地作品),不走 AI 生成 ----
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const pasteOpen = ref(false)
const pasteTitle = ref('')
const pasteAuthor = ref('')
const pasteText = ref('')

const importMenuItems = [
  { label: '上传 TXT', icon: 'i-lucide-file-text', onSelect: onPickFile },
  { label: '粘贴文本', icon: 'i-lucide-clipboard-paste', onSelect: openPasteModal }
]

function onPickFile() {
  fileInput.value?.click()
}

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  try {
    const parsed = await parseLocalNovel(file)
    await saveImported(parsed.title, parsed.chapters, parsed.encoding)
  } catch (err) {
    toast.add({ title: '导入失败', description: err instanceof Error ? err.message : String(err), color: 'error' })
  } finally {
    importing.value = false
  }
}

function openPasteModal() {
  pasteTitle.value = ''
  pasteAuthor.value = ''
  pasteText.value = ''
  pasteOpen.value = true
}

async function onPasteConfirm() {
  const title = pasteTitle.value.trim()
  const author = pasteAuthor.value.trim()
  if (!title || !author || !pasteText.value.trim()) return
  importing.value = true
  try {
    const chapters = parseChaptersFromText(pasteText.value)
    await saveImported(title, chapters, undefined, author)
    pasteOpen.value = false
  } catch (err) {
    toast.add({ title: '导入失败', description: err instanceof Error ? err.message : String(err), color: 'error' })
  } finally {
    importing.value = false
  }
}

/** 解析结果落库 -> 切到个人书架展示,并提示成功 */
async function saveImported(title: string, chapters: ChapterSegment[], encoding?: string, author?: string) {
  await saveWork({
    id: uuid(),
    title,
    author,
    createdAt: new Date().toISOString(),
    chapters,
    encoding,
    syncStatus: 'local'
  })
  activeTab.value = 'personal'
  await refreshLocal()
  toast.add({ title: '已导入', description: `《${title}》已加入本地作品`, color: 'success' })
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6">
    <input
      ref="fileInput"
      type="file"
      accept=".txt,.text"
      class="hidden"
      @change="onFileChosen"
    >
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          我的书架
        </h1>
      </div>
      <div class="flex gap-2">
        <UButton
          label="生成新世界"
          icon="i-lucide-sparkles"
          color="primary"
          size="sm"
          to="/generate"
        />
        <UDropdownMenu :items="importMenuItems">
          <UButton
            label="导入小说"
            icon="i-lucide-upload"
            color="primary"
            variant="soft"
            size="sm"
          />
        </UDropdownMenu>
      </div>
    </div>

    <UTabs
      v-model="activeTab"
      :items="shelfTabs"
      variant="pill"
      color="primary"
    >
      <!-- 官方书架:预置小说,点击进入预览页用其生成世界 -->
      <template #official>
        <div class="mt-4">
          <div
            v-if="officialLoading && officialWorks.length === 0"
            class="text-sm text-neutral-500"
          >
            正在加载官方书架…
          </div>
          <div
            v-else-if="officialWorks.length === 0"
            class="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700"
          >
            暂无预置小说
          </div>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <UCard
              v-for="p in officialWorks"
              :key="p.id"
              class="flex flex-col"
            >
              <p class="break-words font-semibold">
                {{ p.title }}
              </p>
              <p class="truncate text-xs text-neutral-500">
                {{ p.author || '佚名' }}
              </p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <UBadge
                  variant="subtle"
                  size="sm"
                >
                  {{ fmtChars(p.char_count) }}
                </UBadge>
                <UBadge
                  v-for="b in readBadges(progressFor('preset', p.id))"
                  :key="b.label"
                  :color="b.color"
                  variant="soft"
                  size="sm"
                >
                  {{ b.label }}
                </UBadge>
              </div>
              <div class="mt-3 flex flex-wrap gap-2">
                <UButton
                  :label="readBtnLabel(progressFor('preset', p.id))"
                  icon="i-lucide-book-open"
                  color="primary"
                  size="sm"
                  :to="`/read/preset/${p.id}`"
                />
                <UButton
                  label="查看详情"
                  icon="i-lucide-sparkles"
                  color="neutral"
                  variant="soft"
                  size="sm"
                  :to="`/presets/${p.id}`"
                />
              </div>
            </UCard>
          </div>
        </div>
      </template>

      <!-- 个人书架:本地作品 + 云端作品(换设备恢复)+ 最近游戏 -->
      <template #personal>
        <div class="mt-4">
          <!-- 本地作品 -->
          <div class="mb-6">
            <div class="mb-3 flex items-center justify-between">
              <h2 class="font-semibold">
                本地作品
              </h2>
              <UButton
                v-if="!cloudLoaded"
                label="加载云端作品"
                icon="i-lucide-cloud-download"
                color="neutral"
                variant="subtle"
                size="sm"
                @click="loadCloudWorks"
              />
            </div>
            <div
              v-if="works.length === 0"
              class="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700"
            >
              还没有作品——去 <NuxtLink
                to="/generate"
                class="text-primary-500 underline"
              >生成世界</NuxtLink> 上传一本 TXT 开始
            </div>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <UCard
                v-for="w in works"
                :key="w.id"
                class="flex flex-col"
              >
                <p class="break-words font-semibold">
                  {{ w.title }}
                </p>
                <div class="mt-1.5 flex flex-wrap gap-1.5">
                  <UBadge
                    v-if="w.syncStatus === 'synced'"
                    color="success"
                    variant="soft"
                    size="sm"
                  >
                    已同步
                  </UBadge>
                  <UBadge
                    v-else
                    color="neutral"
                    variant="soft"
                    size="sm"
                  >
                    本地
                  </UBadge>
                  <UBadge
                    v-for="b in readBadges(progressFor('work', w.id))"
                    :key="b.label"
                    :color="b.color"
                    variant="soft"
                    size="sm"
                  >
                    {{ b.label }}
                  </UBadge>
                </div>
                <p class="mt-1 text-xs text-neutral-500">
                  作者: {{ w.author || '佚名' }}
                </p>
                <p class="mt-1 text-xs text-neutral-500">
                  章节数: {{ w.chapters.length }} 章
                </p>
                <p class="mt-1 text-xs text-neutral-500">
                  最后操作: {{ fmtTime(w.updatedAt ?? w.createdAt) }}
                </p>
                <div class="mt-1 flex items-end justify-between gap-2">
                  <UBadge
                    v-if="w.tokensUsed"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-coins"
                  >
                    已消耗 {{ w.tokensUsed.toLocaleString() }} tokens
                  </UBadge>
                  <span v-else />
                </div>
                <div class="mt-3 flex flex-wrap gap-1.5">
                  <UButton
                    :label="readBtnLabel(progressFor('work', w.id))"
                    icon="i-lucide-book-open"
                    color="primary"
                    variant="soft"
                    size="sm"
                    :to="`/read/work/${w.id}`"
                  />
                  <UButton
                    label="编辑"
                    icon="i-lucide-pencil"
                    color="neutral"
                    variant="soft"
                    size="sm"
                    :to="`/edit/${w.id}`"
                  />
                  <UButton
                    v-if="w.overlay?.characters?.length"
                    label="选择角色"
                    icon="i-lucide-play"
                    color="primary"
                    size="sm"
                    :to="`/play/${w.id}`"
                  />
                  <UButton
                    label="同步云端"
                    icon="i-lucide-cloud-upload"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    @click="syncWorkToCloud(w)"
                  />
                  <UButton
                    label="删除"
                    icon="i-lucide-trash-2"
                    color="error"
                    variant="subtle"
                    size="sm"
                    @click="onDeleteWork(w)"
                  />
                </div>
              </UCard>
            </div>
          </div>

          <!-- 云端作品(换设备恢复) -->
          <div
            v-if="cloudLoaded"
            class="mb-6"
          >
            <h2 class="mb-3 font-semibold">
              云端作品
            </h2>
            <div
              v-if="cloudWorks.length === 0"
              class="text-sm text-neutral-500"
            >
              云端暂无作品(实体库不上云,只有人物卡/概要/冲突)
            </div>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <UCard
                v-for="cw in cloudWorks"
                :key="cw.id"
                class="flex items-center justify-between gap-2"
              >
                <div class="min-w-0">
                  <p class="break-words text-sm font-semibold">
                    {{ cw.title }}
                  </p>
                  <p class="text-xs text-neutral-500">
                    {{ cw.chapter_count }} 章 · {{ fmtTime(cw.created_at) }}
                  </p>
                </div>
                <UButton
                  label="恢复到本机"
                  icon="i-lucide-download"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  @click="restoreFromCloud(cw.id)"
                />
              </UCard>
            </div>
          </div>

          <!-- 最近游戏 -->
          <div v-if="games.length">
            <h2 class="mb-3 font-semibold">
              继续游戏
            </h2>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <UCard
                v-for="g in games"
                :key="g.id"
                class="flex items-center justify-between gap-2"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">
                    你是「{{ g.playerName }}」
                  </p>
                  <p class="truncate text-xs text-neutral-500">
                    {{ g.currentChapter || '进行中' }} · {{ fmtTime(g.updatedAt) }}
                  </p>
                </div>
                <UButton
                  label="继续"
                  icon="i-lucide-play"
                  color="primary"
                  variant="soft"
                  size="sm"
                  :to="`/games/${g.id}`"
                />
              </UCard>
            </div>
          </div>
        </div>
      </template>
    </UTabs>

    <!-- 粘贴文本导入 -->
    <UModal
      v-model:open="pasteOpen"
      title="粘贴小说"
      description="粘贴整本小说正文,自动按章节切分;只保存在本机"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            label="书名"
            required
          >
            <UInput
              v-model="pasteTitle"
              placeholder="输入书名"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="作者"
            required
          >
            <UInput
              v-model="pasteAuthor"
              placeholder="输入作者名"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="正文"
            required
          >
            <UTextarea
              v-model="pasteText"
              :rows="12"
              autoresize
              class="w-full"
              placeholder="粘贴整本小说正文…"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="取消"
            color="neutral"
            variant="outline"
            @click="pasteOpen = false"
          />
          <UButton
            label="导入"
            icon="i-lucide-upload"
            color="primary"
            :loading="importing"
            :disabled="!pasteTitle.trim() || !pasteAuthor.trim() || !pasteText.trim()"
            @click="onPasteConfirm"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
