<script setup lang="ts">
// /works — 我的书架(登录后):推荐书架(预置小说,可直接生成)+ 个人书架(本地作品 + 云端作品 + 继续游戏)
import type { TabsItem, DropdownMenuItem } from '@nuxt/ui'
import { listWorks, getWork, saveWork, deleteWork, parseLocalNovel, parseChaptersFromText } from '../utils/worldGen'
import { listLocalGames, saveLocalGame, deleteLocalGame } from '../utils/gameStore'
import { deleteGamePoints } from '../utils/gameSaveStore'
import { importWorkFromZip } from '../utils/shareZip'
import { listReadingProgress } from '../utils/readingStore'
import { fetchPrebuiltWorld, installPrebuiltWork } from '../utils/prebuiltWorld'
import type { PrebuiltWorld } from '../utils/prebuiltWorld'
import { setAdultModeEnabled } from '../utils/adultMode'
import { type LocalWork, type LocalGame, type GameState, type PresetNovelRow, type ReadingProgress, type ChapterSegment, uuid } from '#shared/novel'

useHead({ title: 'AI Word2World · 我的书架' })

const works = ref<LocalWork[]>([])
const games = ref<Awaited<ReturnType<typeof listLocalGames>>>([])
const cloudWorks = ref<{ id: string, title: string, chapter_count: number, created_at: string }[]>([])
const cloudLoaded = ref(false)
/** 云端游戏会话(跨设备续玩:在个人中心开启「本地存档上云」后自动上传) */
const cloudGames = ref<{ id: string, player_character_name: string | null, current_chapter: string | null, status: string | null, updated_at: string | null }[]>([])
const cloudGamesLoaded = ref(false)

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

// ---- 推荐书架(预置小说) ----
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

// ---- 推荐书架「直接开始」:用官方预生成世界 0 token 进入选角 ----
const directStartingId = ref<string | null>(null)

async function startPrebuilt(p: PresetNovelRow) {
  if (directStartingId.value) return
  directStartingId.value = p.id
  try {
    const world: PrebuiltWorld | null = await fetchPrebuiltWorld(p.id)
    if (!world) {
      toast.add({ title: '本书暂无官方预生成世界', color: 'warning' })
      return
    }
    const workId = await installPrebuiltWork(p, world)
    // 预置小说进入世界默认开启成人模式(选角页可关)
    setAdultModeEnabled(true)
    await navigateTo(`/play/${workId}`)
  } catch (e) {
    toast.add({ title: '进入失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    directStartingId.value = null
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
  void loadCloudGames()
})

// ---- 云端同步(手动):成功/失败都出 toast,不再静默吞 ----
const syncingWorkId = ref<string | null>(null)

async function syncWorkToCloud(work: LocalWork) {
  if (syncingWorkId.value) return
  syncingWorkId.value = work.id
  try {
    const res = await $fetch('/api/works', { method: 'POST', body: JSON.parse(JSON.stringify(work)) }).catch(() => null)
    if (!res) {
      toast.add({ title: '同步失败,请稍后重试', color: 'error' })
      return
    }
    work.syncStatus = 'synced'
    await saveWork(work)
    await refreshLocal()
    toast.add({ title: '已同步到云端', color: 'success' })
  } finally {
    syncingWorkId.value = null
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
    storyline?: LocalWork['storyline']
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
    overlay: data.overlay ?? undefined,
    storyline: data.storyline ?? existing?.storyline
  })
  await refreshLocal()
}

async function loadCloudGames() {
  cloudGames.value = await $fetch('/api/games').catch(() => [])
  cloudGamesLoaded.value = true
}

/** 从云端恢复游戏会话到本机(新设备续玩);作品未在本地时,用云端世界观兜底重建(章节正文不上云) */
async function restoreCloudGame(id: string) {
  const data = await $fetch<{
    id: string
    novel_id: string | null
    player_character_name: string | null
    player_character_id: string | null
    current_chapter: string | null
    status: string | null
    summary: string | null
    state: GameState | null
    world: LocalWork['overlay'] | null
    entities?: LocalWork['entities']
    conflicts?: LocalWork['conflicts']
    storyline?: LocalWork['storyline']
    messages: LocalGame['messages']
    optionsByMessage: Record<string, { idx: number, text: string }[]>
  }>(`/api/games/${id}`).catch(() => null)
  if (!data) return

  if (data.novel_id && data.world && !(await getWork(data.novel_id))) {
    await saveWork({
      id: data.novel_id,
      title: data.world.title ?? '未命名作品',
      createdAt: new Date().toISOString(),
      chapters: [],
      syncStatus: 'synced',
      overlay: data.world,
      entities: data.entities,
      conflicts: data.conflicts,
      storyline: data.storyline
    })
  }

  let summary: LocalGame['summary'] = null
  if (data.summary) {
    try {
      summary = JSON.parse(data.summary)
    } catch {
      summary = null
    }
  }
  // 云端镜像存的是段标签字符串(如「第3段」),恢复时反解回段号;旧格式原样忽略
  const beatMatch = /^第(\d+)段$/.exec(data.current_chapter ?? '')

  await saveLocalGame({
    id: data.id,
    workId: data.novel_id ?? '',
    playerName: data.player_character_name ?? '玩家',
    characterName: data.player_character_id ?? '',
    state: data.state ?? {},
    messages: data.messages ?? [],
    optionsByMessage: data.optionsByMessage,
    currentBeat: beatMatch ? Number(beatMatch[1]) - 1 : null,
    summary,
    status: data.status === 'ended' ? 'ended' : 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncStatus: 'synced'
  })
  await refreshLocal()
  toast.add({ title: '已恢复到本机,可在「继续游戏」中进入' })
}

// ---- 删除作品:二次确认 + 同步清理关联游戏会话/存盘点(避免孤儿数据不可见不可清) ----
const deleteOpen = ref(false)
const deleteTarget = ref<LocalWork | null>(null)

function askDeleteWork(w: LocalWork) {
  deleteTarget.value = w
  deleteOpen.value = true
}

const deleteGamesCount = computed(() =>
  deleteTarget.value ? games.value.filter(g => g.workId === deleteTarget.value!.id).length : 0)

async function confirmDeleteWork() {
  const w = deleteTarget.value
  if (!w) return
  const orphanGames = games.value.filter(g => g.workId === w.id)
  for (const g of orphanGames) {
    await deleteGamePoints(g.id).catch(() => {})
    await deleteLocalGame(g.id).catch(() => {})
  }
  await deleteWork(w.id)
  deleteOpen.value = false
  deleteTarget.value = null
  await refreshLocal()
  toast.add({
    title: '已删除',
    description: `《${w.title}》${orphanGames.length ? `及其 ${orphanGames.length} 个游戏存档` : ''}已从本机移除`,
    color: 'neutral'
  })
}

/** 云端恢复且无正文:阅读不可用,可「补全正文」后重跑生成 */
function isCloudRestored(w: LocalWork): boolean {
  return w.chapters.length === 0 && !!w.overlay?.characters?.length
}

/** 实体库总数(人物/地点/势力/规则/时间线/物品/伏笔) */
function entityCount(w: LocalWork): number {
  const e = w.entities
  if (!e) return 0
  return e.characters.length + e.locations.length + e.factions.length
    + e.timeline_events.length + e.world_rules.length + e.items.length + e.foreshadowing.length
}

/** 卡片标签:性向单独徽章展示(语义不同),这里只返回玩法/标签,最多 4 个 */
function workCardTags(w: LocalWork): string[] {
  const tags: string[] = []
  for (const k of w.overlay?.kinkProfile ?? []) {
    if (k.theme && !tags.includes(k.theme)) tags.push(k.theme)
    if (tags.length >= 4) break
  }
  if (tags.length < 4) {
    for (const t of w.overlay?.tags ?? []) {
      if (t && !tags.includes(t)) tags.push(t)
      if (tags.length >= 4) break
    }
  }
  return tags.slice(0, 4)
}

/** 去重后的标签总数(超过展示数显示 +N) */
function workCardTagTotal(w: LocalWork): number {
  const kinks = (w.overlay?.kinkProfile ?? []).map(k => k.theme).filter(Boolean)
  return new Set([...kinks, ...(w.overlay?.tags ?? [])].filter(Boolean)).size
}

/** 每部本地作品的「更多操作」菜单:世界详情 / 编辑正文 / 编辑角色卡 / 重新生成世界 / 同步云端 / 删除 */
function workMenuItems(w: LocalWork): DropdownMenuItem[][] {
  return [
    [
      { label: '世界详情', icon: 'i-lucide-globe', onSelect: () => openWorldDetail(w.id) },
      { label: w.chapters.length === 0 ? '补全正文' : '编辑正文', icon: 'i-lucide-pencil', onSelect: () => navigateTo(`/edit/${w.id}`) },
      { label: '编辑角色卡', icon: 'i-lucide-users', onSelect: () => openCharEditor(w.id) },
      { label: '重新生成世界', icon: 'i-lucide-refresh-cw', onSelect: () => navigateTo(`/generate?from=work&id=${w.id}`) },
      { label: '同步云端', icon: 'i-lucide-cloud-upload', disabled: syncingWorkId.value === w.id, onSelect: () => syncWorkToCloud(w) }
    ],
    [
      { label: '删除', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => askDeleteWork(w) }
    ]
  ]
}

// ---- 世界详情弹窗(生成产物总览 + 概览元数据编辑) ----
const worldDetailOpen = ref(false)
const worldDetailWorkId = ref('')

function openWorldDetail(id: string) {
  worldDetailWorkId.value = id
  worldDetailOpen.value = true
}

// ---- 编辑角色卡(操作本地作品 overlay.characters) ----
const charEditWorkId = ref('')
const charEditorOpen = ref(false)

function openCharEditor(id: string) {
  charEditWorkId.value = id
  charEditorOpen.value = true
}

async function onCardsSaved() {
  await refreshLocal()
  toast.add({ title: '角色卡已更新', color: 'success' })
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

// ---- 继续游戏:作品卡片 → 选角色(模态框)→ 该角色全部存档(新页面) ----
const continueOpen = ref(false)
const continueWorkTitle = ref('')
const continueGames = ref<LocalGame[]>([])

/** 该作品是否有本地游戏会话(有则作品卡片显示「继续游戏」按钮) */
function hasGamesFor(workId: string): boolean {
  return games.value.some(g => g.workId === workId)
}

function openContinue(w: LocalWork) {
  continueWorkTitle.value = w.title
  continueGames.value = games.value.filter(g => g.workId === w.id)
  continueOpen.value = true
}

/** 该作品有存档的角色(按最后游玩时间倒序),供模态框选择 */
const continueRoles = computed(() => {
  const byChar = new Map<string, LocalGame[]>()
  for (const g of continueGames.value) {
    const list = byChar.get(g.characterName) ?? []
    list.push(g)
    byChar.set(g.characterName, list)
  }
  return [...byChar.entries()]
    .map(([name, list]) => ({
      name,
      count: list.length,
      lastAt: list.reduce((mx, g) => (g.updatedAt > mx ? g.updatedAt : mx), '')
    }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
})

function pickRole(name: string) {
  const id = continueGames.value.find(g => g.characterName === name)?.workId
  continueOpen.value = false
  if (!id) return
  navigateTo(`/games/continue?workId=${id}&character=${encodeURIComponent(name)}`)
}

const shelfTabs = ref<TabsItem[]>([
  { label: '个人书架', icon: 'i-lucide-book-open', value: 'personal', slot: 'personal' },
  { label: '推荐书架', icon: 'i-lucide-star', value: 'official', slot: 'official' }
])
const activeTab = ref('personal')

// ---- 导入小说:上传 TXT / 粘贴文本 → 解析后直接入库(本地作品),不走 AI 生成 ----
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)
const zipInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const pasteOpen = ref(false)
const pasteTitle = ref('')
const pasteAuthor = ref('')
const pasteText = ref('')

const importMenuItems = [
  { label: '上传 TXT', icon: 'i-lucide-file-text', onSelect: onPickFile },
  { label: '粘贴文本', icon: 'i-lucide-clipboard-paste', onSelect: openPasteModal },
  { label: '导入 ZIP 分享包', icon: 'i-lucide-file-archive', onSelect: onPickZip }
]

function onPickZip() {
  zipInput.value?.click()
}

/** 导入 ZIP 分享包:校验格式与结构后作为个人作品入库(带新鲜 id,不与来源冲突) */
async function onZipChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  try {
    const work = await importWorkFromZip(file)
    await saveWork(work)
    activeTab.value = 'personal'
    await refreshLocal()
    toast.add({ title: '已导入', description: `《${work.title}》已作为个人作品加入书架`, color: 'success' })
  } catch (err) {
    toast.add({ title: '导入失败', description: err instanceof Error ? err.message : String(err), color: 'error' })
  } finally {
    importing.value = false
  }
}

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
    <input
      ref="zipInput"
      type="file"
      accept=".zip,application/zip"
      class="hidden"
      @change="onZipChosen"
    >
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="flex items-center gap-2 text-xl font-semibold">
          <UIcon
            name="i-lucide-library"
            class="size-5 text-primary"
          />
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
      <!-- 推荐书架:预置小说,点击进入预览页用其生成世界 -->
      <template #official>
        <div class="mt-4">
          <p
            class="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900"
          >
            声明:推荐书架内的小说均由网友自发上传,仅用于个人学习与娱乐;若涉及版权问题,请联系我们删除。
          </p>
          <div class="mt-4">
            <div
              v-if="officialLoading && officialWorks.length === 0"
              class="text-sm text-neutral-500"
            >
              正在加载推荐书架…
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
                    v-if="p.hasWorld"
                    label="进入世界"
                    icon="i-lucide-zap"
                    color="primary"
                    size="sm"
                    :loading="directStartingId === p.id"
                    @click="startPrebuilt(p)"
                  />
                  <UButton
                    :label="readBtnLabel(progressFor('preset', p.id))"
                    icon="i-lucide-book-open"
                    color="primary"
                    variant="soft"
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
        </div>
      </template>

      <!-- 个人书架:本地作品 + 云端作品(换设备恢复) -->
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
                    v-else-if="w.syncStatus === 'dirty'"
                    color="warning"
                    variant="soft"
                    size="sm"
                  >
                    待同步
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
                    v-if="isCloudRestored(w)"
                    color="warning"
                    variant="soft"
                    size="sm"
                  >
                    云端恢复 · 无正文
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
                <p class="mt-1 truncate text-xs text-neutral-500">
                  作者: {{ w.author || '佚名' }} · {{ w.chapters.length ? `${w.chapters.length} 章` : '无正文' }}
                </p>
                <p
                  v-if="w.overlay?.setting || w.overlay?.heat"
                  class="mt-1 truncate text-xs text-neutral-500"
                >
                  {{ [w.overlay?.heat ? `尺度:${w.overlay.heat}` : '', w.overlay?.setting].filter(Boolean).join(' · ') }}
                </p>
                <div
                  v-if="w.overlay?.orientation || workCardTags(w).length"
                  class="mt-1.5 flex flex-wrap gap-1"
                >
                  <UBadge
                    v-if="w.overlay?.orientation && w.overlay.orientation !== '不明'"
                    color="info"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-heart"
                  >
                    {{ w.overlay.orientation }}
                  </UBadge>
                  <UBadge
                    v-for="tag in workCardTags(w)"
                    :key="tag"
                    color="primary"
                    variant="subtle"
                    size="sm"
                  >
                    {{ tag }}
                  </UBadge>
                  <UBadge
                    v-if="workCardTagTotal(w) > workCardTags(w).length"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  >
                    +{{ workCardTagTotal(w) - workCardTags(w).length }}
                  </UBadge>
                </div>
                <div
                  v-if="entityCount(w) || w.conflicts?.length || w.warnings?.length"
                  class="mt-1.5 flex flex-wrap gap-1"
                >
                  <UBadge
                    v-if="entityCount(w)"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-globe"
                    class="cursor-pointer"
                    @click="openWorldDetail(w.id)"
                  >
                    实体 {{ entityCount(w) }}
                  </UBadge>
                  <UBadge
                    v-if="w.conflicts?.length"
                    color="warning"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-git-merge"
                    class="cursor-pointer"
                    @click="openWorldDetail(w.id)"
                  >
                    冲突 {{ w.conflicts.length }}
                  </UBadge>
                  <UBadge
                    v-if="w.warnings?.length"
                    color="warning"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-triangle-alert"
                    class="cursor-pointer"
                    @click="openWorldDetail(w.id)"
                  >
                    告警 {{ w.warnings.length }}
                  </UBadge>
                </div>
                <p class="mt-1 text-xs text-neutral-500">
                  最后操作: {{ fmtTime(w.updatedAt ?? w.createdAt) }}
                </p>
                <div class="mt-1">
                  <UBadge
                    v-if="w.tokensUsed"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-coins"
                  >
                    已消耗 {{ w.tokensUsed.toLocaleString() }} tokens
                  </UBadge>
                </div>
                <div class="mt-3 flex flex-wrap items-center gap-1.5">
                  <UButton
                    v-if="!isCloudRestored(w)"
                    :label="readBtnLabel(progressFor('work', w.id))"
                    icon="i-lucide-book-open"
                    color="primary"
                    variant="soft"
                    size="sm"
                    :to="`/read/work/${w.id}`"
                  />
                  <UButton
                    v-else
                    :label="readBtnLabel(progressFor('work', w.id))"
                    icon="i-lucide-book-open"
                    color="neutral"
                    variant="soft"
                    size="sm"
                    @click="toast.add({ title: '云端恢复的作品暂无正文', description: '在「更多 → 补全正文」粘贴全文保存后即可阅读', color: 'warning' })"
                  />
                  <UButton
                    v-if="!w.overlay?.characters?.length"
                    label="生成世界"
                    icon="i-lucide-sparkles"
                    color="primary"
                    size="sm"
                    :to="`/generate?from=work&id=${w.id}`"
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
                    v-if="hasGamesFor(w.id)"
                    label="继续游戏"
                    icon="i-lucide-rotate-ccw"
                    color="primary"
                    variant="outline"
                    size="sm"
                    @click="openContinue(w)"
                  />
                  <UDropdownMenu
                    :items="workMenuItems(w)"
                    :content="{ align: 'end' }"
                  >
                    <UButton
                      icon="i-lucide-settings"
                      color="neutral"
                      variant="soft"
                      size="sm"
                      aria-label="更多操作"
                    />
                  </UDropdownMenu>
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

          <!-- 云端游戏(跨设备恢复续玩) -->
          <div
            v-if="cloudGamesLoaded"
            class="mb-6"
          >
            <h2 class="mb-3 font-semibold">
              云端游戏
            </h2>
            <div
              v-if="cloudGames.length === 0"
              class="text-sm text-neutral-500"
            >
              云端暂无游戏(在个人中心开启「本地存档上云」后,游戏进度会自动上传)
            </div>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <UCard
                v-for="g in cloudGames"
                :key="g.id"
                class="flex items-center justify-between gap-2"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">
                    你是「{{ g.player_character_name || '玩家' }}」
                  </p>
                  <p class="truncate text-xs text-neutral-500">
                    {{ g.current_chapter || '进行中' }} · {{ g.updated_at ? fmtTime(g.updated_at) : '—' }}
                  </p>
                </div>
                <UButton
                  label="恢复到本机"
                  icon="i-lucide-download"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  @click="restoreCloudGame(g.id)"
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

    <!-- 编辑角色卡 -->
    <CharacterCardsModal
      v-model:open="charEditorOpen"
      :work-id="charEditWorkId"
      @saved="onCardsSaved"
    />

    <!-- 世界详情(产物总览 + 概览编辑) -->
    <WorldDetailModal
      v-model:open="worldDetailOpen"
      :work-id="worldDetailWorkId"
      @saved="refreshLocal"
    />

    <!-- 删除作品确认(同时清理该作品的本地游戏存档) -->
    <UModal
      v-model:open="deleteOpen"
      title="删除作品"
      description="此操作不可撤销"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          确定删除《{{ deleteTarget?.title }}》?
          <template v-if="deleteGamesCount">
            该作品下的 {{ deleteGamesCount }} 个本地游戏存档将一并删除。
          </template>
          作品与存档只保存在本机,删除后无法恢复。
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="取消"
            color="neutral"
            variant="outline"
            @click="deleteOpen = false"
          />
          <UButton
            label="删除"
            icon="i-lucide-trash-2"
            color="error"
            @click="confirmDeleteWork"
          />
        </div>
      </template>
    </UModal>

    <!-- 继续游戏:选择角色(该作品有会话的角色) -->
    <UModal
      :open="continueOpen"
      @update:open="continueOpen = $event"
    >
      <template #title>
        <span class="flex items-center gap-2">
          <UIcon
            name="i-lucide-rotate-ccw"
            class="size-4 text-primary"
          />
          继续游戏
        </span>
      </template>
      <template #body>
        <p class="text-xs text-neutral-500">
          《{{ continueWorkTitle }}》 · 选择要续玩的角色
        </p>
        <div class="mt-3 flex flex-col gap-2">
          <button
            v-for="c in continueRoles"
            :key="c.name"
            class="flex items-center justify-between gap-2 rounded-xl border border-neutral-200 px-3 py-2.5 text-left transition hover:border-primary-400 dark:border-neutral-700"
            @click="pickRole(c.name)"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">
                {{ c.name }}
              </p>
              <p class="text-xs text-neutral-500">
                {{ c.count }} 局存档 · 最后 {{ fmtTime(c.lastAt) }}
              </p>
            </div>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 shrink-0 text-neutral-400"
            />
          </button>
        </div>
      </template>
    </UModal>
  </div>
</template>
