<script setup lang="ts">
// /edit/[id] — 本地作品编辑页(与阅读页同款全屏布局与主题)
// 书名 / 作者 / 正文可直接打字修改;每次改动 1s 防抖后自动保存到本机 IndexedDB。
// v1 作品:正文为整本连排文本,保存时按章节标题重新切分,章节结构随原文保留。
// v2(book2)作品:正文即随包归档全文(zip 里的全文 txt,books.fulltext),直接整段读写、不按段拼装。
import { getWork, saveWork, toContentSegments } from '../../utils/worldGen'
import { loadBook2, saveBook2Fulltext } from '../../utils/bookStoreV2'
import { getReadingProgress } from '../../utils/readingStore'
import { readingKey, DEFAULT_READER_SETTINGS, CHAPTER_REGEX } from '#shared/novel'
import type { LocalWork, ReaderSettings, ChapterSegment } from '#shared/novel'

definePageMeta({ layout: 'reader' })

const route = useRoute()
const router = useRouter()
const id = String(route.params.id)

// ---- 加载 ----
const original = ref<LocalWork | null>(null)
/** book2 真源:正文即归档全文 txt(books.fulltext),与 v1 的章节切分保存不同 */
const toast = useToast()
const isBook2 = ref(false)
const loadError = ref('')
const title = ref('')
const author = ref('')
const text = ref('')
/** 云端恢复且无正文的作品:显示补全正文提示条 */
const cloudRestored = ref(false)
const settings = ref<ReaderSettings>({ ...DEFAULT_READER_SETTINGS })

const fontFamilyCss = computed(() => {
  const f = settings.value.font
  if (f === 'serif') return '"Songti SC", "STSong", "SimSun", "Noto Serif SC", serif'
  if (f === 'sans') return '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif'
  return 'var(--font-sans)'
})

/** 与阅读页一致:应用自定义背景色/文字色与背景图 */
const rootBgStyle = computed(() => {
  const s = settings.value
  const st: Record<string, string> = {}
  if (s.customBg) st['--reader-bg'] = s.customBg
  if (s.customText) st['--reader-text'] = s.customText
  if (s.bgImage) {
    st.backgroundImage = `url("${s.bgImage}")`
    st.backgroundSize = 'cover'
    st.backgroundPosition = 'center'
    st.backgroundAttachment = 'fixed'
  }
  return st
})

function joinChapters(chapters: ChapterSegment[]): string {
  return chapters.map(c => (c.title ? `${c.title}\n` : '') + c.content).join('\n\n')
}

/** 进入页面立即加载阅读页保存过的主题/字号/背景设置,保证编辑页观感一致且不等正文 */
async function loadSettings() {
  try {
    const p = await getReadingProgress(readingKey('work', id))
    if (p?.settings) settings.value = { ...DEFAULT_READER_SETTINGS, ...p.settings }
  } catch {
    /* 无进度记录时用默认设置 */
  }
}

async function loadBook() {
  try {
    // 优先 book2 真源:正文 = 归档全文 txt(books.fulltext),不按段拼接
    const b2 = await loadBook2(id)
    if (b2) {
      isBook2.value = true
      title.value = b2.manifest.title
      author.value = b2.manifest.author ?? ''
      cloudRestored.value = !b2.fulltext
      text.value = b2.fulltext ?? ''
    } else {
      isBook2.value = false
      const work = await getWork(id)
      if (!work) throw new Error('本地未找到该作品')
      original.value = work
      title.value = work.title
      author.value = work.author ?? ''
      // 云端恢复的作品可能没有正文(chapters 为空):允许进入并提示粘贴全文补全,不再直接报错
      cloudRestored.value = work.chapters.length === 0
      text.value = joinChapters(work.chapters)
    }
    dirty.value = false
    saveState.value = 'saved'
    lastSavedAt.value = null
    saveWatchReady = true
    await nextTick()
    requestAnimationFrame(resizeBody)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
}

// ---- 正文输入框自动高度 ----
const bodyEl = ref<HTMLTextAreaElement | null>(null)

function resizeBody() {
  const el = bodyEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// ---- 章节定位(按章节标题行划分正文,供底部工具条上一章/下一章与进度使用) ----
const scrollEl = ref<HTMLElement | null>(null)

interface ChapterAnchor {
  title: string
  /** 章节标题行在正文中的起始字符偏移 */
  offset: number
}

const chapterAnchors = computed<ChapterAnchor[]>(() => {
  const anchors: ChapterAnchor[] = []
  let offset = 0
  for (const line of text.value.split('\n')) {
    const lineStart = offset
    offset += line.length + 1
    if (CHAPTER_REGEX.test(line)) anchors.push({ title: line.trim(), offset: lineStart })
  }
  if (anchors.length === 0) {
    // 全文无章节标题:退化为单章
    anchors.push({ title: '', offset: 0 })
  } else if (anchors[0]!.offset > 0) {
    // 首个标题之前有前置内容:补「前言」锚点(旧版分章格式的作品仍有标题行,单段全文则天然退化单章)
    anchors.unshift({ title: '', offset: 0 })
  }
  return anchors
})

const chapterIndexNow = ref(0)
const chapterRatio = ref(0)

function chapLabel(i: number) {
  const a = chapterAnchors.value[i]
  if (!a) return ''
  return a.title || (i === 0 ? '前言' : `第 ${i + 1} 部分`)
}

function anchorAt(charOffset: number): number {
  const list = chapterAnchors.value
  let idx = 0
  for (let i = list.length - 1; i >= 1; i--) {
    const a = list[i]
    if (a && charOffset >= a.offset) {
      idx = i
      break
    }
  }
  return idx
}

function updateChapterFromChar(charOffset: number) {
  const list = chapterAnchors.value
  if (!list.length) return
  const idx = anchorAt(charOffset)
  const a = list[idx]!
  const span = (list[idx + 1]?.offset ?? text.value.length) - a.offset
  chapterIndexNow.value = idx
  chapterRatio.value = span > 0 ? Math.min(1, Math.max(0, (charOffset - a.offset) / span)) : 0
}

function onScroll() {
  const scroller = scrollEl.value
  const el = bodyEl.value
  if (!scroller || !el) return
  const total = text.value.length
  if (!total) {
    updateChapterFromChar(0)
    return
  }
  // 视口顶端对应的字符偏移(按正文高度近似换算)
  const intoEl = Math.max(0, scroller.scrollTop - el.offsetTop)
  updateChapterFromChar(Math.min(total, (intoEl / Math.max(1, el.offsetHeight)) * total))
}

function scrollToChapter(i: number) {
  const list = chapterAnchors.value
  if (i < 0 || i >= list.length) return
  const el = bodyEl.value
  const scroller = scrollEl.value
  const start = list[i]!.offset
  const total = text.value.length || 1
  if (el && scroller) {
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = Math.min(max, Math.max(0, el.offsetTop + (start / total) * el.offsetHeight - scroller.clientHeight * 0.25))
  }
  // 光标同步到章节开头,便于继续打字
  el?.focus()
  el?.setSelectionRange(start, start)
  updateChapterFromChar(start)
}

function goChapter(dir: 1 | -1) {
  const cur = bodyEl.value ? anchorAt(bodyEl.value.selectionStart ?? 0) : chapterIndexNow.value
  const next = Math.min(chapterAnchors.value.length - 1, Math.max(0, cur + dir))
  scrollToChapter(next)
}

const percent = computed(() => {
  const total = chapterAnchors.value.length
  if (!total) return 0
  return Math.min(100, Math.round(((chapterIndexNow.value + chapterRatio.value) / total) * 100))
})

watch(text, () => requestAnimationFrame(() => {
  resizeBody()
  // 章节结构随输入变化时按光标位置重新定位
  if (bodyEl.value) updateChapterFromChar(bodyEl.value.selectionStart ?? 0)
}))

// ---- 1s 防抖自动保存 ----
const dirty = ref(false)
const saveState = ref<'saved' | 'saving' | 'error'>('saved')
const lastSavedAt = ref<number | null>(null)

let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving = false
let queued = false
let saveWatchReady = false

function scheduleSave() {
  if (!original.value && !isBook2.value) return
  dirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void flushSave()
  }, 1000)
}

async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  const base = original.value
  if (!base && !isBook2.value) return
  if (saving) {
    queued = true
    return
  }
  saving = true
  saveState.value = 'saving'
  try {
    if (isBook2.value) {
      // v2 真源:正文 = 归档全文 txt;书名/作者写回 manifest(books 行 title 随 manifest)
      // v14:单行写回(book-texts + books meta 小行),不再整书四表重建
      const t = title.value.trim() || '未命名作品'
      const a = author.value.trim()
      await saveBook2Fulltext(id, text.value, { title: t, author: a || null })
    } else {
      if (!base) throw new Error('本地未找到该作品')
      const parsed = toContentSegments(text.value)
      await saveWork({
        ...base,
        title: title.value.trim() || '未命名作品',
        author: author.value.trim() || undefined,
        chapters: parsed,
        // 内容有实际改动:云端已有对应作品时标记待同步,书架卡片会显示「待同步」徽章
        syncStatus: base.syncStatus === 'synced' ? 'dirty' : base.syncStatus,
        createdAt: base.createdAt,
        updatedAt: new Date().toISOString()
      })
    }
    dirty.value = false
    saveState.value = 'saved'
    lastSavedAt.value = Date.now()
    // v2 编辑的是归档全文,段正文(引擎所用)是另一份受控副本,不会随之改变:
    // 首次保存后提示一次,告知分段正文需到「分段」视图单独调整
    if (isBook2.value) {
      const key = `edit-seg-hint:${id}`
      let hinted = false
      try {
        hinted = sessionStorage.getItem(key) === '1'
      } catch { /* 无痕模式等 */ }
      if (!hinted) {
        try {
          sessionStorage.setItem(key, '1')
        } catch { /* 忽略 */ }
        toast.add({
          title: '已保存归档全文',
          description: '分段正文(游玩所用)是独立副本,如需同步调整请到书架「世界详情 → 分段」按段编辑',
          color: 'info'
        })
      }
    }
  } catch {
    // 正文为空时保留改动,等下一次输入再自动重试
    saveState.value = 'error'
  } finally {
    saving = false
    if (queued) {
      queued = false
      void flushSave()
    }
  }
}

watch([title, author, text], () => {
  // 初始加载赋值(loadBook 完成前)不触发保存
  if (!saveWatchReady) return
  scheduleSave()
}, { flush: 'sync' })

const saveStatus = computed(() => {
  if (saveState.value === 'saving') return '保存中…'
  if (saveState.value === 'error') {
    return text.value.trim() ? '自动保存失败,稍后重试' : '正文为空,粘贴全文后会自动保存'
  }
  if (dirty.value) return '有未保存的修改'
  return lastSavedAt.value
    ? `已保存 ${new Date(lastSavedAt.value).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '自动保存已开启'
})

// ---- 生命周期 ----
function onHidden() {
  if (document.visibilityState === 'hidden') void flushSave()
}

function onKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd + S 立即保存
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void flushSave()
  }
}

onMounted(() => {
  void loadSettings()
  void loadBook()
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', onHidden)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', resizeBody)
})

onBeforeUnmount(() => {
  void flushSave()
  document.removeEventListener('visibilitychange', onHidden)
  window.removeEventListener('pagehide', onHidden)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', resizeBody)
})

function goBack() {
  if (window.history.length > 1) router.back()
  else navigateTo('/works')
}

useSeoMeta({ title: computed(() => `${title.value.trim() || '编辑'} · AI Word2World`) })
</script>

<template>
  <div
    class="reader-root h-full w-full overflow-hidden"
    :class="`reader-theme-${settings.theme}`"
    :style="rootBgStyle"
  >
    <!-- 顶部工具条(编辑页常驻) -->
    <header class="reader-bar reader-topbar">
      <button
        type="button"
        class="reader-icon-btn"
        aria-label="返回"
        @click="goBack"
      >
        <UIcon name="i-lucide-arrow-left" />
      </button>
      <div class="min-w-0 flex-1 px-2 text-center">
        <p class="truncate text-sm font-semibold">
          {{ title.trim() || '未命名作品' }}
        </p>
        <p class="truncate text-xs opacity-70">
          {{ saveStatus }}
        </p>
      </div>
      <button
        type="button"
        class="reader-preview-btn"
        aria-label="预览阅读"
        @click="navigateTo(`/read/work/${id}`)"
      >
        <UIcon
          name="i-lucide-book-open"
          class="size-4"
        />
        预览
      </button>
    </header>

    <!-- 编辑区 -->
    <main
      ref="scrollEl"
      class="reader-scroll absolute inset-0 overflow-y-auto overscroll-none"
      @scroll.passive="onScroll"
    >
      <div
        v-if="!original && !isBook2 && !loadError"
        class="flex h-full items-center justify-center gap-2 text-sm opacity-70"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin"
        />
        正在加载作品…
      </div>

      <div
        v-else-if="loadError"
        class="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <UIcon
          name="i-lucide-book-x"
          class="size-10"
        />
        <p class="text-sm">
          {{ loadError }}
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class="reader-plain-btn"
            @click="goBack"
          >
            返回
          </button>
        </div>
      </div>

      <div
        v-else
        class="reader-pane mx-auto max-w-3xl px-6 pb-44 pt-28 sm:px-10"
      >
        <div
          v-if="cloudRestored && !isBook2"
          class="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300"
        >
          该作品为云端恢复,本机暂无正文。在下方粘贴小说全文后会自动按章节切分保存,之后可回书架「重新生成世界」或直接阅读。
        </div>
        <div
          v-else-if="cloudRestored && isBook2"
          class="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300"
        >
          该 v2 作品暂无正文全文。粘贴整本小说后保存,会作为归档全文(作品包内的全文 txt)写入;游玩所用分段正文如需调整,请回书架用「编辑角色卡」按段编辑。
        </div>
        <input
          v-model="title"
          class="edit-book-title"
          placeholder="输入书名"
        >
        <input
          v-model="author"
          class="edit-book-author"
          placeholder="输入作者"
        >
        <textarea
          ref="bodyEl"
          v-model="text"
          class="edit-body"
          :style="{
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
            fontFamily: fontFamilyCss
          }"
          placeholder="正文内容,可直接修改…"
          spellcheck="false"
        />
      </div>
    </main>

    <!-- 底部工具条:与阅读页一致,上一章/下一章 + 全书进度 -->
    <footer class="reader-bar reader-bottombar">
      <div class="flex items-center gap-3 px-5 pb-3 pt-2">
        <button
          type="button"
          class="reader-icon-btn"
          aria-label="上一章"
          :disabled="chapterIndexNow <= 0"
          @click="goChapter(-1)"
        >
          <UIcon name="i-lucide-chevron-left" />
        </button>
        <div class="min-w-0 flex-1">
          <div class="reader-progress">
            <div
              class="h-full rounded-full"
              :style="{ width: `${percent}%` }"
            />
          </div>
          <p class="mt-1 text-right text-xs opacity-70">
            {{ percent }}% · {{ chapLabel(chapterIndexNow) || '前言' }} · {{ chapterIndexNow + 1 }}/{{ chapterAnchors.length }}
          </p>
        </div>
        <button
          type="button"
          class="reader-icon-btn"
          aria-label="下一章"
          :disabled="chapterIndexNow >= chapterAnchors.length - 1"
          @click="goChapter(1)"
        >
          <UIcon name="i-lucide-chevron-right" />
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* 与阅读页一致的配色与布局(颜色变量由 .reader-theme-* 全局类提供) */
.reader-root {
  -webkit-tap-highlight-color: transparent;
  background-color: var(--reader-bg);
  color: var(--reader-text);
}

.reader-scroll {
  scrollbar-gutter: stable;
}
.reader-scroll::-webkit-scrollbar {
  width: 5px;
}
.reader-scroll::-webkit-scrollbar-thumb {
  background: var(--reader-border);
  border-radius: 999px;
}

/* 工具条(样式与阅读页相同) */
.reader-bar {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 30;
  background: var(--reader-toolbar, var(--reader-bg));
  border-color: var(--reader-border);
  color: var(--reader-text);
}
.reader-topbar {
  top: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: calc(env(safe-area-inset-top) + 8px) env(safe-area-inset-right) 8px env(safe-area-inset-left);
  border-bottom: 1px solid;
}
.reader-bottombar {
  bottom: 0;
  padding-bottom: env(safe-area-inset-bottom);
  border-top: 1px solid;
}
.reader-preview-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 6px;
  padding: 7px 14px;
  border: 1px solid var(--reader-border);
  border-radius: 999px;
  font-size: 13px;
  color: var(--reader-text);
  transition: opacity 0.15s;
}
.reader-preview-btn:active {
  opacity: 0.6;
}
.reader-progress {
  height: 3px;
  border-radius: 999px;
  background: var(--reader-border);
  overflow: hidden;
}
.reader-progress > div {
  background: var(--reader-text);
  opacity: 0.75;
}
.reader-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 999px;
  font-size: 18px;
  color: inherit;
  transition: opacity 0.15s;
}
.reader-icon-btn:active {
  opacity: 0.55;
}
.reader-plain-btn {
  padding: 6px 16px;
  border: 1px solid var(--reader-border);
  border-radius: 999px;
  font-size: 13px;
  color: var(--reader-text);
  transition: opacity 0.15s;
}
.reader-plain-btn:active {
  opacity: 0.6;
}

/* ---- 可编辑字段(与阅读页章节排版同风格) ---- */
.edit-book-title {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  border-bottom: 1px dashed transparent;
  outline: none;
  padding: 0.4em 0 0.2em;
  text-align: center;
  font-size: 1.3em;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--reader-text);
  caret-color: var(--reader-text);
}
.edit-book-title::placeholder {
  color: var(--reader-text);
  opacity: 0.35;
}
.edit-book-title:focus {
  border-bottom-color: var(--reader-border);
}

.edit-book-author {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  border-bottom: 1px dashed transparent;
  outline: none;
  padding: 0.2em 0 0.3em;
  text-align: center;
  font-size: 0.95em;
  opacity: 0.75;
  color: var(--reader-text);
  caret-color: var(--reader-text);
}
.edit-book-author::placeholder {
  color: var(--reader-text);
  opacity: 0.35;
}
.edit-book-author:focus {
  border-bottom-color: var(--reader-border);
}

/* 正文编辑区:占满宽度、随内容自动增高,排版贴近阅读正文 */
.edit-body {
  display: block;
  width: 100%;
  margin-top: 2.2em;
  padding: 0;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  color: var(--reader-text);
  caret-color: var(--reader-text);
  text-align: justify;
  word-break: break-word;
  white-space: pre-wrap;
}
.edit-body::placeholder {
  color: var(--reader-text);
  opacity: 0.35;
}
</style>
