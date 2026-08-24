<script setup lang="ts">
// /read/[src]/[id] — 沉浸式全屏阅读页(预置小说 preset / 本地作品 work)
// 功能:护眼背景主题、字号/行距/字体设置、左右滑动切章、自动保存阅读位置(章节+滚动比例)、
//      目录抽屉、读完检测(末章底部"全书完")、浏览器原生全屏。进度存 IndexedDB(reading store)。
import { getWork, touchWork } from '../../../utils/worldGen'
import { loadPresetChapters } from '../../../utils/chapters'
import { getReadingProgress, saveReadingProgress } from '../../../utils/readingStore'
import {
  readingKey, DEFAULT_READER_SETTINGS, READER_FONT_SIZES, READER_LINE_HEIGHTS
} from '#shared/novel'
import type { ChapterSegment, ReaderSettings, ReadingProgress, ReaderTheme } from '#shared/novel'

definePageMeta({ layout: 'reader' })

const route = useRoute()
const router = useRouter()
const src = route.params.src as string
const id = String(route.params.id)
const key = readingKey(src === 'work' ? 'work' : 'preset', id)

// ---- 加载 ----
const chapters = ref<ChapterSegment[]>([])
const bookTitle = ref('')
const loadingState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')

const progressKey = computed(() => key)
const chapterIndex = ref(0)
const settings = ref<ReaderSettings>({ ...DEFAULT_READER_SETTINGS })
const finished = ref(false)

const scrollEl = ref<HTMLElement | null>(null)
const scrollRatio = ref(0)
const scrollMax = ref(0)

function chapLabel(i: number) {
  const ch = chapters.value[i]
  if (!ch) return ''
  return ch.title || (i === 0 ? '前言' : `第 ${i + 1} 部分`)
}

// ---- 用户设置:进入页面立即加载(主题/字号/背景等),不等小说正文加载完成 ----
let cachedProgress: ReadingProgress | null = null

async function loadSettings() {
  try {
    cachedProgress = await getReadingProgress(progressKey.value)
  } catch {
    cachedProgress = null
  }
  if (cachedProgress?.settings) {
    settings.value = { ...DEFAULT_READER_SETTINGS, ...cachedProgress.settings }
  }
}

async function loadBook() {
  if (src !== 'work' && src !== 'preset') {
    loadingState.value = 'error'
    loadError.value = '无效的阅读入口'
    return
  }
  try {
    if (src === 'work') {
      const work = await getWork(id)
      if (!work || work.chapters.length === 0) throw new Error('本地未找到该作品或无可读章节')
      chapters.value = work.chapters
      bookTitle.value = work.title
      void touchWork(id)
    } else {
      const loaded = await loadPresetChapters(id)
      chapters.value = loaded.chapters
      bookTitle.value = loaded.title
    }
    loadingState.value = 'ready'
    const restored = await restoreProgress()
    // 自动隐藏开启时:进入默认显示工具条 + 引导提示;始终显示模式无需提示
    uiVisible.value = true
    if (restored) {
      showToast(`已恢复 · ${chapLabel(chapterIndex.value)}`)
    } else if (settings.value.autohide) {
      showToast('轻点屏幕可呼出 / 隐藏菜单')
    }
    armAutoHide()
  } catch (e) {
    loadingState.value = 'error'
    loadError.value = e instanceof Error ? e.message : String(e)
  }
}

// ---- 进度恢复(返回是否成功恢复过进度;设置已由 loadSettings 先行应用) ----
async function restoreProgress(): Promise<boolean> {
  const p = cachedProgress ?? (await getReadingProgress(progressKey.value).catch(() => null))
  if (!p) return false
  chapterIndex.value = Math.min(Math.max(p.chapterIndex, 0), chapters.value.length - 1)
  finished.value = !!p.finished
  // 章节内容渲染稳定后再恢复滚动位置
  await nextTick()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      applyScrollRatio(p.scrollRatio)
    })
  })
  return true
}

function applyScrollRatio(ratio: number) {
  const el = scrollEl.value
  if (!el) return
  scrollMax.value = Math.max(0, el.scrollHeight - el.clientHeight)
  el.scrollTop = Math.max(0, Math.min(ratio, 1)) * scrollMax.value
}

// ---- 进度保存(滚动节流 + 关键时机立即落盘) ----
let saveTimer: ReturnType<typeof setTimeout> | undefined

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    flushSave()
  }, 800)
}

function flushSave() {
  if (!chapters.value.length) return
  void saveReadingProgress({
    key: progressKey.value,
    src: src === 'work' ? 'work' : 'preset',
    id,
    title: bookTitle.value,
    chapterIndex: chapterIndex.value,
    scrollRatio: scrollRatio.value,
    settings: { ...settings.value },
    finished: finished.value,
    updatedAt: new Date().toISOString()
  })
}

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  scrollMax.value = Math.max(0, el.scrollHeight - el.clientHeight)
  scrollRatio.value = scrollMax.value > 0 ? el.scrollTop / scrollMax.value : 0
  pingUI()
  scheduleSave()
}

// 切章后回到顶部并立即保存
watch(chapterIndex, () => {
  scrollRatio.value = 0
  void nextTick(() => applyScrollRatio(0))
  flushSave()
})

watch(settings, () => flushSave(), { deep: true })

// ---- UI 显隐(设置「自动隐藏」开:轻点屏幕呼出/收起,超时自动隐藏;关:始终显示) ----
const uiVisible = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | undefined

/** 工具栏是否可见:未开启自动隐藏时恒显示 */
const barsVisible = computed(() => !settings.value.autohide || uiVisible.value)

function toggleUI() {
  if (!settings.value.autohide) return
  uiVisible.value = !uiVisible.value
  if (uiVisible.value) armAutoHide()
}

function armAutoHide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    uiVisible.value = false
  }, 3200)
}

function pingUI() {
  if (!uiVisible.value || !settings.value.autohide) return
  armAutoHide()
}

// ---- 长按自动滚动(设置开启后,长按正文任意处向下滚动;松手/滑动即停) ----
const autoScrolling = ref(false)
let pressTimer: ReturnType<typeof setTimeout> | undefined
let scrollRaf: number | undefined

function startAutoScroll() {
  if (autoScrolling.value) return
  autoScrolling.value = true
  // 亚像素累积:低速挡每帧不足 1px,先累加再整帧推进,避免被取整卡住不动
  let acc = 0
  const tick = () => {
    const el = scrollEl.value
    if (!el) {
      stopAutoScroll()
      return
    }
    // 速度分档:5 挡为原 2 挡速度(约 144px/s),其余挡位依次递减
    acc += settings.value.autoScrollSpeed * 0.48
    const step = Math.floor(acc)
    if (step > 0) {
      el.scrollTop += step
      acc -= step
    }
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) {
      stopAutoScroll()
      return
    }
    scrollRaf = requestAnimationFrame(tick)
  }
  scrollRaf = requestAnimationFrame(tick)
}

function stopAutoScroll() {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = undefined
  }
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = undefined
  }
  autoScrolling.value = false
}

// ---- 左右滑动切章(仅 touch;水平位移占优且超过阈值;首/末章边界抖动提示) ----
const SWIPE_THRESHOLD = 80
const SWITCH_DURATION = 240
const swipe = reactive({ active: false, dragging: false, startX: 0, startY: 0, dx: 0, dy: 0 })
const paneTrans = ref(0) // 当前横向位移 px
const paneAnimating = ref(false) // 切换/回弹时开启过渡
const switching = ref(false) // 切章动画中,禁止再滑
const edgeShakeOn = ref(false)

function onPointerDown(e: PointerEvent) {
  pingUI()
  // 任何指针类型都先清空手势残留,避免上一次滑动位移吞掉后续的点击呼出
  swipe.dx = 0
  swipe.dy = 0
  if (drawerOpen.value || settingsOpen.value || switching.value) {
    stopAutoScroll()
    return
  }
  // 长按 380ms 未移动 -> 进入自动滚动(触摸与鼠标均可)
  if (settings.value.autoScroll) {
    stopAutoScroll()
    pressTimer = setTimeout(() => {
      pressTimer = undefined
      startAutoScroll()
    }, 380)
  }
  if (e.pointerType !== 'touch') return
  swipe.active = true
  swipe.dragging = false
  swipe.startX = e.clientX
  swipe.startY = e.clientY
}

function onPointerMove(e: PointerEvent) {
  if (!swipe.active) return
  const dx = e.clientX - swipe.startX
  const dy = e.clientY - swipe.startY
  swipe.dx = dx
  swipe.dy = dy
  if (!swipe.dragging) {
    // 指头一移动就取消未触发/已触发的自动滚动
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) stopAutoScroll()
    // 水平意图明显才接管手势;否则纵向交给浏览器滚动
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      swipe.dragging = true
    } else if (Math.abs(dy) > 12) {
      swipe.active = false
      return
    }
  }
  if (swipe.dragging && !switching.value) {
    paneTrans.value = dx
  }
}

function onPointerUp() {
  stopAutoScroll()
  if (!swipe.active) return
  const { dx, dy, dragging } = swipe
  swipe.active = false
  swipe.dragging = false
  if (dragging) {
    if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      switchChapter(dx < 0 ? 1 : -1)
    } else {
      springBack()
    }
  }
}

function onPointerCancel() {
  stopAutoScroll()
  if (!swipe.active) return
  swipe.active = false
  swipe.dragging = false
  springBack()
}

function switchChapter(dir: 1 | -1) {
  const next = chapterIndex.value + dir
  if (next < 0 || next >= chapters.value.length) {
    edgeShake()
    return
  }
  if (switching.value) return
  switching.value = true
  paneAnimating.value = true
  paneTrans.value = -dir * (window.innerWidth || 375)
  setTimeout(() => {
    // 旧内容飞出后换章,瞬移到另一侧再飞入
    chapterIndex.value = next
    paneAnimating.value = false
    paneTrans.value = dir * (window.innerWidth || 375)
    void nextTick(() => {
      requestAnimationFrame(() => {
        paneAnimating.value = true
        paneTrans.value = 0
        setTimeout(() => {
          switching.value = false
        }, SWITCH_DURATION + 60)
      })
    })
  }, SWITCH_DURATION)
}

function springBack() {
  paneAnimating.value = true
  paneTrans.value = 0
}

function edgeShake() {
  if (edgeShakeOn.value) return
  edgeShakeOn.value = true
  setTimeout(() => {
    edgeShakeOn.value = false
  }, 320)
}

function onPaneClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest('button, a, input, [data-reader-no-toggle]')) return
  // 手势结束后残留的位移不算点击
  if (Math.abs(swipe.dx) > 10 || switching.value) return
  if (settings.value.pageMode === 'tap') {
    // 点击翻页:同一章节内滚动一屏(左半区上一页/右半区下一页),排除顶/底工具条高度
    const main = e.currentTarget as HTMLElement
    const rect = main.getBoundingClientRect()
    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
    const el = scrollEl.value
    if (el) {
      const rootEl = main.parentElement
      const topH = rootEl?.querySelector('.reader-topbar')?.clientHeight ?? 0
      const bottomH = rootEl?.querySelector('.reader-bottombar')?.clientHeight ?? 0
      const bodyH = Math.max(1, el.clientHeight - topH - bottomH)
      const step = Math.max(80, bodyH * 0.88)
      el.scrollBy({ top: ratio < 0.5 ? -step : step, behavior: 'smooth' })
    }
    return
  }
  toggleUI()
}

// ---- 目录抽屉 ----
const drawerOpen = ref(false)

function goChapter(i: number) {
  drawerOpen.value = false
  if (i === chapterIndex.value) return
  chapterIndex.value = i
}

function isRead(i: number) {
  if (i < chapterIndex.value) return true
  if (i === chapterIndex.value && (scrollRatio.value > 0.02 || finished.value)) return true
  return false
}

// ---- 设置面板 ----
const settingsOpen = ref(false)

// 目录/设置打开时强制显示工具条;关闭后若开启自动隐藏则恢复计时
watch([drawerOpen, settingsOpen], () => {
  if (drawerOpen.value || settingsOpen.value) {
    uiVisible.value = true
    if (hideTimer) clearTimeout(hideTimer)
  } else if (settings.value.autohide) {
    armAutoHide()
  }
})

const themeOptions: { value: ReaderTheme, label: string, color: string, text: string }[] = [
  { value: 'sepia', label: '羊皮纸', color: '#f5efe0', text: '#5c4b37' },
  { value: 'green', label: '护眼', color: '#c7edcc', text: '#2f4a38' },
  { value: 'night', label: '夜间', color: '#141414', text: '#a3a3a3' },
  { value: 'light', label: '纯白', color: '#ffffff', text: '#3a3a3a' }
]

/** 翻页模式选项(下拉列表):默认滚动滑动;点击模式下左半区上一章、右半区下一章 */
const pageModeOptions = [
  { label: '滚动滑动', value: 'scroll' },
  { label: '左半区点击', value: 'tap' }
] satisfies { label: string, value: 'scroll' | 'tap' }[]

const pageModeModel = computed({
  get: () => settings.value.pageMode,
  set: (v: 'scroll' | 'tap') => { settings.value = { ...settings.value, pageMode: v } }
})

/** 根容器样式:自定义背景色/文字色 + 背景图(背景图优先生效,底色作为加载兜底) */
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

/** 预设主题生效中(未被自定义色/背景图覆盖) */
function presetActive(v: ReaderTheme) {
  const s = settings.value
  return s.theme === v && !s.customBg && !s.bgImage
}

/** 选预设主题:清掉自定义色与背景图,回到内置配色 */
function pickTheme(v: ReaderTheme) {
  settings.value = { ...settings.value, theme: v, customBg: undefined, customText: undefined, bgImage: undefined }
}

/** 自定义模式:设置了自定义色或背景图即为自定义(此时预设主题不高亮) */
const customMode = computed(() => !!(settings.value.customBg || settings.value.customText || settings.value.bgImage))

/** 点"自定义"按钮:未启用时用当前主题配色作为起点,可再在下方选择器里调整 */
function pickCustom() {
  if (customMode.value) return
  const base = themeOptions.find(t => t.value === settings.value.theme)
  settings.value = {
    ...settings.value,
    customBg: base?.color ?? '#ffffff',
    customText: base?.text ?? '#333333'
  }
}

/** 自定义背景色/文字色(未设置时拾色器显示空态) */
const customBgModel = computed({
  get: () => settings.value.customBg ?? undefined,
  set: (v?: string) => { settings.value = { ...settings.value, customBg: v || undefined } }
})
const customTextModel = computed({
  get: () => settings.value.customText ?? undefined,
  set: (v?: string) => { settings.value = { ...settings.value, customText: v || undefined } }
})

// ---- 背景图:读取图片 → 等比压缩 → dataURL 存进设置(随进度一起落 IndexedDB) ----
const bgFileInput = ref<HTMLInputElement | null>(null)
const bgProcessing = ref(false)

async function fileToBgDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('图片加载失败'))
      i.src = url
    })
    const MAX = 1600
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法处理图片')
    ctx.drawImage(img, 0, 0, w, h)
    if (file.type === 'image/png' && hasAlpha(ctx, w, h)) {
      return canvas.toDataURL('image/png')
    }
    return canvas.toDataURL('image/jpeg', 0.82)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 是否含透明像素(有透明则保留 PNG,否则压缩为 JPEG 更省空间) */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, Math.min(w, 800), Math.min(h, 800)).data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true
  }
  return false
}

async function onBgFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  bgProcessing.value = true
  try {
    const dataUrl = await fileToBgDataUrl(file)
    settings.value = { ...settings.value, bgImage: dataUrl }
  } catch (err) {
    showToast(err instanceof Error ? err.message : '背景图处理失败')
  } finally {
    bgProcessing.value = false
  }
}

function removeBgImage() {
  settings.value = { ...settings.value, bgImage: undefined }
}

/** 最大可用字号(设置面板禁用态比较) */
const MAX_READER_FONT_SIZE = READER_FONT_SIZES[READER_FONT_SIZES.length - 1]!

function setFontSize(delta: number) {
  const idx = READER_FONT_SIZES.indexOf(settings.value.fontSize as (typeof READER_FONT_SIZES)[number])
  const base = idx < 0 ? READER_FONT_SIZES.indexOf(DEFAULT_READER_SETTINGS.fontSize as (typeof READER_FONT_SIZES)[number]) : idx
  const next = Math.min(READER_FONT_SIZES.length - 1, Math.max(0, base + delta))
  settings.value = { ...settings.value, fontSize: READER_FONT_SIZES[next]! }
}

const fontFamilyCss = computed(() => {
  const f = settings.value.font
  if (f === 'serif') return '"Songti SC", "STSong", "SimSun", "Noto Serif SC", serif'
  if (f === 'sans') return '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif'
  return 'var(--font-sans)'
})

// ---- 全文进度 / 读完检测 ----
const totalChars = computed(() => chapters.value.reduce((s, c) => s + c.content.length, 0))
const isLastChapter = computed(() => chapters.value.length > 0 && chapterIndex.value === chapters.value.length - 1)
const percent = computed(() => {
  if (!chapters.value.length) return 0
  return Math.min(100, Math.round(((chapterIndex.value + scrollRatio.value) / chapters.value.length) * 100))
})

function markFinished() {
  if (finished.value) return
  finished.value = true
  flushSave()
}

watch(scrollRatio, (r) => {
  if (isLastChapter.value && r >= 0.97) markFinished()
})

function restartBook() {
  finished.value = false
  chapterIndex.value = 0
}

// ---- 轻提示 ----
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(msg: string) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 2600)
}

// ---- 原生全屏 / 返回 ----
const isFullscreen = ref(false)
function onFsChange() {
  isFullscreen.value = !!document.fullscreenElement
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
  } else {
    void document.documentElement.requestFullscreen?.().catch(() => {})
  }
}

function goBack() {
  if (window.history.length > 1) router.back()
  else navigateTo('/works')
}

function onKeydown(e: KeyboardEvent) {
  if (drawerOpen.value || settingsOpen.value) return
  if (e.key === 'ArrowLeft') switchChapter(-1)
  else if (e.key === 'ArrowRight') switchChapter(1)
}

// ---- 生命周期 ----
function onHidden() {
  if (document.visibilityState === 'hidden') flushSave()
}

onMounted(() => {
  void loadSettings()
  void loadBook()
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', onHidden)
  document.addEventListener('fullscreenchange', onFsChange)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  flushSave()
  document.removeEventListener('visibilitychange', onHidden)
  window.removeEventListener('pagehide', onHidden)
  document.removeEventListener('fullscreenchange', onFsChange)
  window.removeEventListener('keydown', onKeydown)
})

const pageTitle = computed(() => `${bookTitle.value || '阅读'} · AISpankWorld`)
useSeoMeta({ title: pageTitle })
</script>

<template>
  <div
    class="reader-root h-full w-full overflow-hidden select-text"
    :class="[`reader-theme-${settings.theme}`, { 'select-none': swipe.dragging || autoScrolling }]"
    :style="rootBgStyle"
  >
    <!-- 顶部工具条 -->
    <Transition name="reader-fade">
      <header
        v-if="barsVisible"
        class="reader-bar reader-topbar"
        :class="{ 'is-fullscreen': isFullscreen }"
      >
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
            {{ bookTitle || chapLabel(chapterIndex) }}
          </p>
          <p class="truncate text-xs opacity-70">
            {{ chapLabel(chapterIndex) }} · {{ chapterIndex + 1 }}/{{ chapters.length }}
          </p>
        </div>
        <button
          type="button"
          class="reader-icon-btn"
          aria-label="设置"
          @click="settingsOpen = true"
        >
          <UIcon name="i-lucide-settings" />
        </button>
        <button
          type="button"
          class="reader-icon-btn"
          aria-label="目录"
          @click="drawerOpen = true"
        >
          <UIcon name="i-lucide-list" />
        </button>
      </header>
    </Transition>

    <!-- 正文区(天然纵向滚动;横向手势用于切章) -->
    <main
      ref="scrollEl"
      class="reader-scroll absolute inset-0 overflow-y-auto overscroll-none"
      style="touch-action: pan-y"
      @scroll.passive="onScroll"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="stopAutoScroll"
      @contextmenu.prevent
      @click="onPaneClick"
    >
      <!-- 加载中 -->
      <div
        v-if="loadingState === 'loading'"
        class="flex h-full items-center justify-center gap-2 text-sm opacity-70"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin"
        />
        正在加载正文…
      </div>

      <!-- 错误 -->
      <div
        v-else-if="loadingState === 'error'"
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
          <button
            type="button"
            class="reader-plain-btn"
            @click="loadBook"
          >
            重试
          </button>
        </div>
      </div>

      <!-- 正文 -->
      <div
        v-else
        class="reader-pane mx-auto min-h-full max-w-3xl px-6 pb-44 pt-10 sm:px-10"
        :class="{
          'reader-anim': paneAnimating,
          'reader-edge-shake': edgeShakeOn,
          'reader-bars-on': barsVisible
        }"
        :style="{
          transform: `translateX(${paneTrans}px)`,
          opacity: 1 - Math.min(Math.abs(paneTrans) / 600, 0.35)
        }"
      >
        <article class="reader-article">
          <h1 class="reader-chapter-title">
            {{ chapLabel(chapterIndex) }}
          </h1>
          <div
            class="reader-body"
            :style="{
              fontSize: `${settings.fontSize}px`,
              lineHeight: settings.lineHeight,
              fontFamily: fontFamilyCss
            }"
          >
            <p
              v-for="(para, i) in (chapters[chapterIndex]?.content || '').split(/\n+/).filter(s => s.trim())"
              :key="i"
            >
              {{ para.trim() }}
            </p>
          </div>

          <!-- 末章:全书完卡片(滚到底时出现) -->
          <section
            v-if="isLastChapter"
            class="reader-finish"
          >
            <p class="text-2xl">
              🎉 全书完
            </p>
            <p class="mt-2 text-sm opacity-80">
              《{{ bookTitle || chapLabel(chapterIndex) }}》· {{ chapters.length }} 章 · {{ totalChars.toLocaleString() }} 字
            </p>
            <p class="mt-1 text-xs opacity-60">
              {{ finished ? '已完成阅读,谢谢你读完这本书' : '阅读到底部后将记录为已读完' }}
            </p>
            <div class="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                class="reader-plain-btn"
                @click="goBack"
              >
                返回书架
              </button>
              <button
                type="button"
                class="reader-plain-btn"
                @click="restartBook"
              >
                从第一章重读
              </button>
            </div>
          </section>
        </article>
      </div>
    </main>

    <!-- 底部工具条 -->
    <Transition name="reader-fade">
      <footer
        v-if="barsVisible"
        class="reader-bar reader-bottombar"
      >
        <div class="flex items-center gap-3 px-5 pb-3 pt-2">
          <button
            type="button"
            class="reader-icon-btn"
            aria-label="上一章"
            :disabled="chapterIndex <= 0"
            @click="switchChapter(-1)"
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
              {{ percent }}% · 第 {{ chapterIndex + 1 }}/{{ chapters.length }} 章
            </p>
          </div>
          <button
            type="button"
            class="reader-icon-btn"
            aria-label="下一章"
            :disabled="chapterIndex >= chapters.length - 1"
            @click="switchChapter(1)"
          >
            <UIcon name="i-lucide-chevron-right" />
          </button>
        </div>
      </footer>
    </Transition>

    <!-- 目录抽屉 -->
    <Transition name="reader-fade">
      <div
        v-if="drawerOpen"
        class="reader-overlay"
        @click="drawerOpen = false"
      />
    </Transition>
    <Transition name="reader-drawer">
      <aside
        v-if="drawerOpen"
        class="reader-drawer"
      >
        <header
          class="flex items-center justify-between border-b px-4 py-3"
          :style="{ borderColor: 'var(--reader-border)' }"
        >
          <p class="text-sm font-semibold">
            目录 · {{ chapters.length }} 章
          </p>
          <button
            type="button"
            class="reader-icon-btn"
            aria-label="关闭目录"
            @click="drawerOpen = false"
          >
            <UIcon name="i-lucide-x" />
          </button>
        </header>
        <nav class="reader-drawer-list">
          <button
            v-for="(ch, i) in chapters"
            :key="i"
            type="button"
            class="reader-chapter-item"
            :class="{
              'is-current': i === chapterIndex,
              'is-read': isRead(i)
            }"
            @click="goChapter(i)"
          >
            <span class="shrink-0 text-xs opacity-60">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="min-w-0 flex-1 truncate text-left">{{ chapLabel(i) }}</span>
            <UIcon
              v-if="isRead(i)"
              name="i-lucide-check"
              class="size-3.5 opacity-50"
            />
          </button>
        </nav>
      </aside>
    </Transition>

    <!-- 设置面板 -->
    <Transition name="reader-fade">
      <div
        v-if="settingsOpen"
        class="reader-overlay"
        @click="settingsOpen = false"
      />
    </Transition>
    <Transition name="reader-sheet">
      <section
        v-if="settingsOpen"
        class="reader-sheet"
      >
        <header
          class="flex items-center justify-between border-b px-5 py-3"
          :style="{ borderColor: 'var(--reader-border)' }"
        >
          <p class="text-sm font-semibold">
            阅读设置
          </p>
          <button
            type="button"
            class="reader-icon-btn"
            aria-label="关闭设置"
            @click="settingsOpen = false"
          >
            <UIcon name="i-lucide-x" />
          </button>
        </header>

        <div class="reader-sheet-body space-y-5 px-5 py-4">
          <!-- 背景 -->
          <div>
            <p class="mb-2 text-sm font-semibold opacity-90">
              背景
            </p>
            <!-- 主题按钮列表:左侧色样方形预览 + 右侧名称 -->
            <div class="space-y-1.5">
              <button
                v-for="opt in themeOptions"
                :key="opt.value"
                type="button"
                class="reader-bg-option"
                :class="{ 'is-on': presetActive(opt.value) }"
                @click="pickTheme(opt.value)"
              >
                <span
                  class="reader-bg-swatch"
                  :style="{ backgroundColor: opt.color }"
                />
                <span class="min-w-0 flex-1 text-left">{{ opt.label }}</span>
                <UIcon
                  v-if="presetActive(opt.value)"
                  name="i-lucide-check"
                  class="shrink-0 opacity-70"
                />
              </button>
              <button
                type="button"
                class="reader-bg-option"
                :class="{ 'is-on': customMode }"
                @click="pickCustom"
              >
                <span
                  class="reader-bg-swatch"
                  :style="{ backgroundColor: settings.customBg ?? themeOptions.find(t => t.value === settings.theme)?.color ?? '#ffffff' }"
                />
                <span class="min-w-0 flex-1 text-left">自定义</span>
                <UIcon
                  v-if="customMode"
                  name="i-lucide-check"
                  class="shrink-0 opacity-70"
                />
              </button>
            </div>

            <!-- 自定义模式:背景色 / 文字颜色 -->
            <template v-if="customMode">
              <div class="mt-3 flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-medium opacity-85">
                    自定义背景色
                  </p>
                  <p class="mt-0.5 text-[11px] opacity-45">
                    设置后覆盖上方主题色板
                  </p>
                </div>
                <ReaderColorField v-model="customBgModel" />
              </div>
              <div class="mt-3 flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-medium opacity-85">
                    自定义文字颜色
                  </p>
                  <p class="mt-0.5 text-[11px] opacity-45">
                    搭配背景图 / 深色背景时使用
                  </p>
                </div>
                <ReaderColorField v-model="customTextModel" />
              </div>

              <!-- 背景图(归属自定义区) -->
              <div class="mt-3 rounded-xl border p-3" :style="{ borderColor: 'var(--reader-border)' }">
                <p class="mb-2 text-sm font-semibold opacity-90">
                  背景图
                </p>
                <div class="flex items-center gap-2">
                  <img
                    v-if="settings.bgImage"
                    :src="settings.bgImage"
                    alt="背景图预览"
                    class="h-10 w-16 shrink-0 rounded-lg border object-cover"
                    :style="{ borderColor: 'var(--reader-border)' }"
                  >
                  <button
                    type="button"
                    class="reader-plain-btn"
                    :disabled="bgProcessing"
                    @click="bgFileInput?.click()"
                  >
                    <span v-if="bgProcessing">处理中…</span>
                    <span v-else>{{ settings.bgImage ? '更换' : '上传' }}背景图</span>
                  </button>
                  <button
                    v-if="settings.bgImage"
                    type="button"
                    class="reader-plain-btn"
                    @click="removeBgImage"
                  >
                    移除
                  </button>
                  <input
                    ref="bgFileInput"
                    type="file"
                    accept="image/*"
                    class="hidden"
                    @change="onBgFileChosen"
                  >
                </div>
                <p class="mt-2 text-[11px] opacity-45">
                  图片自动压缩并只保存在本机;建议搭配浅色系图片,文字颜色可自行调整
                </p>
              </div>
            </template>
          </div>

          <!-- 字号 -->
          <div class="flex items-center justify-between">
            <p class="text-xs font-medium opacity-85">
              字号
            </p>
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="reader-icon-btn"
                aria-label="减小字号"
                :disabled="settings.fontSize <= READER_FONT_SIZES[0]"
                @click="setFontSize(-1)"
              >
                <UIcon name="i-lucide-minus" />
              </button>
              <span class="w-10 text-center text-sm tabular-nums">{{ settings.fontSize }}</span>
              <button
                type="button"
                class="reader-icon-btn"
                aria-label="增大字号"
                :disabled="settings.fontSize >= MAX_READER_FONT_SIZE"
                @click="setFontSize(1)"
              >
                <UIcon name="i-lucide-plus" />
              </button>
            </div>
          </div>

          <!-- 行距 -->
          <div class="flex items-center justify-between">
            <p class="text-xs font-medium opacity-85">
              行距
            </p>
            <div class="flex gap-1.5">
              <button
                v-for="lh in READER_LINE_HEIGHTS"
                :key="lh"
                type="button"
                class="reader-seg"
                :class="{ 'is-on': settings.lineHeight === lh }"
                @click="settings = { ...settings, lineHeight: lh }"
              >
                {{ lh }}
              </button>
            </div>
          </div>

          <!-- 字体 -->
          <div class="flex items-center justify-between">
            <p class="text-xs font-medium opacity-85">
              字体
            </p>
            <div class="flex gap-1.5">
              <button
                v-for="f in ([{ v: 'system', l: '系统' }, { v: 'serif', l: '衬线' }, { v: 'sans', l: '黑体' }] as const)"
                :key="f.v"
                type="button"
                class="reader-seg"
                :class="{ 'is-on': settings.font === f.v }"
                @click="settings = { ...settings, font: f.v }"
              >
                {{ f.l }}
              </button>
            </div>
          </div>

          <!-- 翻页模式 -->
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium opacity-85">
                翻页模式
              </p>
              <p class="mt-0.5 text-[11px] opacity-45">
                {{ settings.pageMode === 'tap' ? '点击左半区上一页、右半区下一页(本章内滚动)' : '滚动浏览;可横向滑动切章' }}
              </p>
            </div>
            <USelectMenu
              v-model="pageModeModel"
              :items="pageModeOptions"
              value-key="value"
              :search-input="false"
              size="sm"
              class="w-32"
            />
          </div>

          <!-- 长按自动滚动 -->
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium opacity-85">
                长按自动滚动
              </p>
              <p class="mt-0.5 text-[11px] opacity-45">
                长按正文自动向下滚动,松手停止
              </p>
            </div>
            <USwitch
              v-model="settings.autoScroll"
              size="sm"
              aria-label="长按自动滚动"
            />
          </div>
          <div
            v-if="settings.autoScroll"
            class="flex items-center justify-between"
          >
            <div>
              <p class="text-xs font-medium opacity-85">
                滚动速度
              </p>
              <p class="mt-0.5 text-[11px] opacity-45">
                1 挡最慢 · 5 挡最快
              </p>
            </div>
            <div class="flex gap-1.5">
              <button
                v-for="n in 5"
                :key="n"
                type="button"
                class="reader-seg"
                :class="{ 'is-on': settings.autoScrollSpeed === n }"
                @click="settings = { ...settings, autoScrollSpeed: n }"
              >
                {{ n }}
              </button>
            </div>
          </div>

          <!-- 工具栏自动隐藏 -->
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium opacity-85">
                工具栏自动隐藏
              </p>
              <p class="mt-0.5 text-[11px] opacity-45">
                关闭时顶部/底部栏常驻显示
              </p>
            </div>
            <USwitch
              v-model="settings.autohide"
              size="sm"
              aria-label="工具栏自动隐藏"
            />
          </div>

          <!-- 全屏阅读 -->
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium opacity-85">
                全屏阅读
              </p>
              <p class="mt-0.5 text-[11px] opacity-45">
                隐藏地址栏等浏览器界面元素
              </p>
            </div>
            <USwitch
              :model-value="isFullscreen"
              size="sm"
              aria-label="全屏阅读"
              @update:model-value="toggleFullscreen"
            />
          </div>
        </div>
      </section>
    </Transition>

    <!-- 恢复位置轻提示 -->
    <Transition name="reader-fade">
      <div
        v-if="toast"
        class="reader-toast"
      >
        <UIcon
          name="i-lucide-book-marked"
          class="size-4"
        />
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ---- 阅读页基础布局与配色(颜色变量由 .reader-theme-* 全局类提供) ---- */
.reader-root {
  -webkit-tap-highlight-color: transparent;
  background-color: var(--reader-bg);
  color: var(--reader-text);
}

/* 正文滚动区 */
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

/* 滑动切换的位移容器 */
.reader-pane {
  will-change: transform;
}
/* 工具栏常驻时正文顶部留出工具条高度(避免遮挡章节标题) */
.reader-pane.reader-bars-on {
  padding-top: 5.5rem;
}
.reader-anim {
  transition: transform 240ms ease;
}
.reader-edge-shake {
  animation: reader-shake 320ms ease;
}
@keyframes reader-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-14px); }
  50% { transform: translateX(9px); }
  70% { transform: translateX(-5px); }
}

/* 章节排版 */
.reader-chapter-title {
  text-align: center;
  font-size: 1.3em;
  font-weight: 600;
  letter-spacing: 0.06em;
  margin-bottom: 1.6em;
  padding-top: 0.4em;
}
.reader-body p {
  margin-bottom: 0.6em;
  text-align: justify;
  word-break: break-word;
}
.reader-finish {
  margin-top: 3.5rem;
  padding-top: 2rem;
  border-top: 1px dashed var(--reader-border);
  text-align: center;
}

/* 工具条 */
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
.reader-icon-btn:disabled {
  opacity: 0.3;
  pointer-events: none;
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
.reader-plain-btn:disabled {
  opacity: 0.45;
  pointer-events: none;
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

/* 弹层 */
.reader-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.35);
}
.reader-drawer {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  z-index: 50;
  width: min(82vw, 320px);
  display: flex;
  flex-direction: column;
  background: var(--reader-bg);
  color: var(--reader-text);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
}
.reader-drawer-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.reader-chapter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--reader-text);
}
.reader-chapter-item.is-current {
  background: var(--reader-text);
  color: var(--reader-bg);
  font-weight: 600;
}
.reader-chapter-item:not(.is-current):active {
  background: var(--reader-border);
}
.reader-chapter-item.is-read:not(.is-current) {
  opacity: 0.75;
}
.reader-sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  border-top: 1px solid var(--reader-border);
  border-radius: 16px 16px 0 0;
  background: var(--reader-bg);
  color: var(--reader-text);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.12);
  padding-bottom: env(safe-area-inset-bottom);
}
/* 设置内容区:超出面板高度时内部滚动,标题头保持固定 */
.reader-sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.reader-sheet-body::-webkit-scrollbar {
  width: 5px;
}
.reader-sheet-body::-webkit-scrollbar-thumb {
  background: var(--reader-border);
  border-radius: 999px;
}
/* 主题按钮列表:左侧方形色样 + 右侧名称 */
.reader-bg-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--reader-border);
  font-size: 13px;
  color: var(--reader-text);
  background: transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.reader-bg-option:active {
  opacity: 0.65;
}
.reader-bg-option.is-on {
  border-color: var(--reader-text);
  background: color-mix(in srgb, var(--reader-text) 10%, transparent);
}
.reader-bg-swatch {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1px solid var(--reader-border);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
}
.reader-seg {
  padding: 5px 12px;
  border: 1px solid var(--reader-border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--reader-text);
}
.reader-seg.is-on {
  background: var(--reader-text);
  border-color: var(--reader-text);
  color: var(--reader-bg);
}

/* 轻提示 */
.reader-toast {
  position: absolute;
  left: 50%;
  bottom: 84px;
  z-index: 60;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 13px;
  background: var(--reader-text);
  color: var(--reader-bg);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
}

/* 过渡 */
.reader-fade-enter-active,
.reader-fade-leave-active {
  transition: opacity 0.18s ease;
}
.reader-fade-enter-from,
.reader-fade-leave-to {
  opacity: 0;
}
.reader-drawer-enter-active,
.reader-drawer-leave-active {
  transition: transform 0.22s ease;
}
.reader-drawer-enter-from,
.reader-drawer-leave-to {
  transform: translateX(100%);
}
.reader-sheet-enter-active,
.reader-sheet-leave-active {
  transition: transform 0.22s ease;
}
.reader-sheet-enter-from,
.reader-sheet-leave-to {
  transform: translateY(100%);
}
</style>
