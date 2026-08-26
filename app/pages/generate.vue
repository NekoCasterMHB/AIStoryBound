<script setup lang="ts">
// /generate — 生成世界页(游客可见,但生成需要登录):未登录显示引导卡 + 弹出登录模态框;
// 登录后选择 TXT → 本地编排生成(实时 token 消耗)→ 完成 → 跳选角页。
// 也支持预置小说详情页跳转(?from=preset&id=xxx&eco=0|1):自动加载该小说为附件,直接进入确认页由用户确认。
import { parseLocalNovel, generateWorld } from '../utils/worldGen'
import { CancelledError } from '../utils/aiRelay'
import { checkWorldGenQuota, estimateWorldGenTokens } from '../utils/tokenQuota'
import { loadPresetChapters } from '../utils/chapters'
import { useAuthModal } from '~/composables/useAuthModal'
import { useAuthSession } from '../utils/auth-client'
import type { LocalWork, ChapterSegment, PresetNovelRow } from '#shared/novel'
import type { GenerateProgress } from '../utils/worldGen'
import type { TokenQuotaInfo } from '../utils/tokenQuota'

useHead({ title: 'AI Word2World · 生成世界' })

const route = useRoute()

/** 详情页"用这本小说生成世界"跳转的目标预置小说 id(?from=preset&id=xxx;空 id 视为未携带) */
const presetSource = computed(() => {
  const from = route.query.from
  const id = route.query.id
  return from === 'preset' && typeof id === 'string' && id.trim() ? id.trim() : null
})

/** 当前附件是否来自预置小说库(确认页展示来源徽章;改选其他文件/取消后清除) */
const fromPreset = ref(false)
/** 预置小说元数据作者:生成时直接采用,跳过联网识别(省 token) */
const presetAuthor = ref<string | null>(null)

const toast = useToast()

const { data: session } = await useAuthSession()
const loggedIn = computed(() => !!session.value?.user)
const { requireLogin } = useAuthModal()

const resultWork = ref<LocalWork | null>(null)

/** 平台 token 额度预检结果(不足时提示,不阻断生成) */
const quotaWarn = ref<TokenQuotaInfo | null>(null)

/** 解析完成、待用户确认的原稿(确认后才进入生成管线) */
const pendingGen = ref<{ title: string, chapters: ChapterSegment[], frontMatter: string } | null>(null)

/** 生成模式:false=完整(默认),true=节约(跳过一致性检查与人物卡润色,省约一半 token) */
const ecoMode = ref(false)

/** 全书字数(与额度预检同口径:各章正文长度合计) */
const totalChars = computed(() =>
  pendingGen.value?.chapters.reduce((sum, c) => sum + c.content.length, 0) ?? 0
)

/** 预估本次生成消耗(按流水线分阶段建模,与平台额度预检同一函数;缺省生成参数) */
const estimatedTokens = computed(() => estimateWorldGenTokens(totalChars.value, ecoMode.value))

/** 切换生成模式后刷新额度预检(估算系数随模式变化) */
watch(ecoMode, async (eco) => {
  if (genState.value.phase === 'confirm' && pendingGen.value) {
    quotaWarn.value = await checkWorldGenQuota(totalChars.value, { eco })
  }
})

/** 字数友好显示:≥1 万显示"x.x 万字" */
function formatChars(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万字`
  return `${n.toLocaleString()} 字`
}

const fileInput = ref<HTMLInputElement | null>(null)
const uploadCard = ref<HTMLElement | null>(null)
const picking = ref(false)
const isDragging = ref(false)
const genState = ref<{
  phase: 'idle' | 'parsing' | 'confirm' | 'generating' | 'done' | 'error'
  title: string
  progress: GenerateProgress | null
  error: string | null
  resultId: string | null
  tokensUsed: number
}>({
  phase: 'idle',
  title: '',
  progress: null,
  error: null,
  resultId: null,
  tokensUsed: 0
})

/** 生成流水线阶段(UI stepper 展示,与 GenerateProgress.stage 对应) */
const stages = [
  { key: 'parse', label: '解析', icon: 'i-lucide-file-text' },
  { key: 'author', label: '作者', icon: 'i-lucide-user-round' },
  { key: 'extract', label: '提取', icon: 'i-lucide-boxes' },
  { key: 'merge', label: '合并', icon: 'i-lucide-git-merge' },
  { key: 'check', label: '校验', icon: 'i-lucide-shield-check' },
  { key: 'synthesize', label: '成卡', icon: 'i-lucide-wand-sparkles' }
] as const

const stageLabel: Record<string, string> = {
  parse: '解析文件…',
  author: '识别作者…',
  extract: '提取世界观元素…',
  merge: '合并实体与校验引用…',
  check: '一致性检查…',
  synthesize: '生成人物卡与简介…',
  done: '完成'
}

/** 当前所处阶段下标(parsing 开始时无 progress,视为 0) */
const stageIndex = computed(() => {
  if (genState.value.progress) {
    const i = stages.findIndex(s => s.key === genState.value.progress!.stage)
    return i >= 0 ? i : stages.length - 1
  }
  return genState.value.phase === 'parsing' ? 0 : -1
})

/** 整体进度百分比:按阶段分段映射,全程单调递增(extract 内 15→80,之后逐段进位) */
const genPercent = computed(() => {
  const p = genState.value.progress
  if (genState.value.phase === 'done' || p?.stage === 'done') return 100
  if (!p) return 5 // parsing 阶段
  if (p.stage === 'extract') {
    return p.totalUnits ? Math.round(15 + (p.doneUnits / p.totalUnits) * 65) : 15
  }
  return { parse: 5, author: 15, merge: 85, check: 92, synthesize: 97 }[p.stage] ?? 30
})

// 实时 token 展示:管线保证数值单调不减,这里再做平滑动画(指数趋近,避免大跳变)
const liveTarget = computed(() => genState.value.progress?.liveTokens ?? 0)
const liveShown = ref(0)
let shownCur = 0
let shownRaf = 0
watch(liveTarget, (target) => {
  if (genState.value.phase !== 'generating') return
  cancelAnimationFrame(shownRaf)
  const tick = () => {
    const diff = target - shownCur
    if (diff <= 1) {
      shownCur = target
    } else {
      shownCur += Math.max(1, Math.round(diff * 0.12))
    }
    liveShown.value = Math.round(shownCur)
    if (shownCur < target) shownRaf = requestAnimationFrame(tick)
  }
  shownRaf = requestAnimationFrame(tick)
})

/** 在途生成的取消控制器与运行序号(取消/新任务竞态保护) */
const abortCtrl = ref<AbortController | null>(null)
let runSeq = 0

// 未登录访问:引导登录(不强制跳页)
const askingLogin = ref(false)
onMounted(async () => {
  // 预置小说详情页跳转:先引导登录,再自动加载该小说为附件,直接进入确认页
  if (presetSource.value) {
    if (!loggedIn.value && !askingLogin.value) {
      askingLogin.value = true
      await requireLogin()
      askingLogin.value = false
    }
    // 详情页勾选的节约模式随跳转带过来
    if (route.query.eco === '1') ecoMode.value = true
    await loadPresetIntoConfirm(presetSource.value)
    return
  }
  if (!loggedIn.value && !askingLogin.value) {
    askingLogin.value = true
    await requireLogin()
    askingLogin.value = false
  }
})

/** Hero 主按钮:未登录先登录,已登录则滚动到上传卡 */
async function onHeroStart() {
  if (!loggedIn.value) {
    await requireLogin()
  }
  await nextTick()
  uploadCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onPickFile() {
  picking.value = true
  fileInput.value?.click()
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) void handleFile(file)
}

function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void handleFile(file)
}

async function handleFile(file: File) {
  picking.value = false
  quotaWarn.value = null
  pendingGen.value = null
  fromPreset.value = false
  presetAuthor.value = null
  const seq = ++runSeq
  // 重置平滑计数,开始新一轮展示
  cancelAnimationFrame(shownRaf)
  shownCur = 0
  liveShown.value = 0
  genState.value = { phase: 'parsing', title: file.name, progress: null, error: null, resultId: null, tokensUsed: 0 }
  try {
    const parsed = await parseLocalNovel(file)
    genState.value.title = parsed.title
    if (seq !== runSeq) return // 解析期间已被取消
    pendingGen.value = { title: parsed.title, chapters: parsed.chapters, frontMatter: parsed.frontMatter }
    // 生成前预检平台 token 额度(不足时提示,不阻断)
    quotaWarn.value = await checkWorldGenQuota(totalChars.value, { eco: ecoMode.value })
    // 先展示字数与预估消耗,用户确认后才进入生成管线
    genState.value.phase = 'confirm'
  } catch (err) {
    if (seq !== runSeq) return // 已取消或已被新任务接管
    if (err instanceof CancelledError) {
      // 用户主动取消:回到上传态,不当作失败
      genState.value = { phase: 'idle', title: '', progress: null, error: null, resultId: null, tokensUsed: 0 }
      return
    }
    genState.value = {
      phase: 'error',
      title: file.name,
      progress: null,
      error: err instanceof Error ? err.message : String(err),
      resultId: null,
      tokensUsed: 0
    }
  }
}

/** 详情页跳转场景:自动加载预置小说全文(IndexedDB 缓存优先,未命中经下载接口)并进入确认页,与上传同一管线 */
async function loadPresetIntoConfirm(presetId: string) {
  const seq = ++runSeq
  quotaWarn.value = null
  pendingGen.value = null
  fromPreset.value = false
  // 重置平滑计数,开始新一轮展示
  cancelAnimationFrame(shownRaf)
  shownCur = 0
  liveShown.value = 0
  genState.value = { phase: 'parsing', title: '预置小说', progress: null, error: null, resultId: null, tokensUsed: 0 }
  try {
    // 元数据(标题/作者;轻量接口,失败仅影响标题兜底,不阻断加载)
    let meta: PresetNovelRow | null = null
    try {
      meta = await $fetch<PresetNovelRow>(`/api/presets/${presetId}`)
    } catch {
      // 忽略:标题回退到切章结果,作者回退到联网识别
    }
    if (seq !== runSeq) return // 加载期间已被取消
    const { chapters, title } = await loadPresetChapters(presetId)
    if (seq !== runSeq) return
    const useTitle = meta?.title ?? title
    pendingGen.value = { title: useTitle, chapters, frontMatter: '' }
    presetAuthor.value = meta?.author ?? null
    fromPreset.value = true
    genState.value.title = useTitle
    // 先展示字数与预估消耗,用户确认后才进入生成管线
    genState.value.phase = 'confirm'
    quotaWarn.value = await checkWorldGenQuota(totalChars.value, { eco: ecoMode.value })
  } catch (err) {
    if (seq !== runSeq) return // 已取消或被新任务接管
    fromPreset.value = false
    genState.value = {
      phase: 'error',
      title: '预置小说',
      progress: null,
      error: err instanceof Error ? err.message : String(err),
      resultId: null,
      tokensUsed: 0
    }
  }
}

async function runGeneration(title: string, chapters: Parameters<typeof generateWorld>[1], frontMatter: string, seq: number, knownAuthor?: string) {
  const ctrl = new AbortController()
  abortCtrl.value = ctrl
  genState.value.phase = 'generating'
  // 只认当前运行序号的进度回调,避免已取消管线的残留事件覆盖新任务状态
  const applyProgress = (p: GenerateProgress) => {
    if (seq === runSeq) genState.value.progress = { ...p }
  }
  const { work } = await generateWorld(title, chapters, applyProgress, {
    frontMatter,
    signal: ctrl.signal,
    eco: ecoMode.value,
    // 预置小说元数据自带作者:直接采用,跳过正文/联网识别(省 token)
    knownAuthor
  })
  if (seq !== runSeq) return
  genState.value.phase = 'done'
  genState.value.progress = null
  genState.value.resultId = work.id
  genState.value.tokensUsed = work.tokensUsed ?? 0
  resultWork.value = work
  abortCtrl.value = null
}

/** 确认页"开始生成":确认字数与预估消耗后进入 AI 管线 */
function startGenerationFromConfirm() {
  const pending = pendingGen.value
  if (!pending) return
  pendingGen.value = null
  const seq = ++runSeq
  void runGeneration(pending.title, pending.chapters, pending.frontMatter, seq, presetAuthor.value ?? undefined)
}

/** 确认页"重新选择":回到上传态并直接打开文件选择 */
function repickFile() {
  pendingGen.value = null
  quotaWarn.value = null
  fromPreset.value = false
  presetAuthor.value = null
  genState.value = { phase: 'idle', title: '', progress: null, error: null, resultId: null, tokensUsed: 0 }
  onPickFile()
}

/** 取消生成:中止在途 AI 调用、作废当前管线并回到上传态 */
function cancelGeneration() {
  runSeq++
  abortCtrl.value?.abort()
  abortCtrl.value = null
  pendingGen.value = null
  quotaWarn.value = null
  fromPreset.value = false
  presetAuthor.value = null
  genState.value = { phase: 'idle', title: '', progress: null, error: null, resultId: null, tokensUsed: 0 }
  toast.add({
    title: '已取消生成',
    description: '未产生任何扣费,可重新上传开始。',
    color: 'neutral',
    icon: 'i-lucide-circle-stop'
  })
}

/** 底部"四步流程"卡片数据 */
const steps = [
  { icon: 'i-lucide-file-up', title: '上传小说', desc: '拖入或选择整本 TXT,本地解析编码、清洗并自动切分章节' },
  { icon: 'i-lucide-boxes', title: '提取世界观', desc: 'AI 分章并发提取人物、地点、势力、规则与伏笔' },
  { icon: 'i-lucide-git-merge', title: '合并与校验', desc: '实体合并去重、原文引用比对、一致性检查,异常标警告' },
  { icon: 'i-lucide-compass', title: '选择角色进入', desc: '生成人物卡与故事简介,选角后即可开始游玩' }
]

/** 底部特性卡片数据 */
const features = [
  { icon: 'i-lucide-gauge', title: '实时消耗', desc: '生成全程显示 token 实时消耗,完成后写入作品卡' },
  { icon: 'i-lucide-search-check', title: '引用校验', desc: '每条设定带原文引用并与正文比对,未通过校验的会标记告警' },
  { icon: 'i-lucide-cloud-upload', title: '云端同步', desc: '生成结果可手动同步到云端,换设备恢复继续游玩' }
]
</script>

<template>
  <div class="relative overflow-hidden">
    <!-- 背景装饰:细网格 + 品牌光晕(低透明度,保持简约) -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0"
    >
      <div class="bg-grid absolute inset-0" />
      <div class="absolute -top-40 left-1/2 h-120 w-190 -translate-x-1/2 rounded-full bg-primary-400/20 blur-3xl dark:bg-primary-500/10" />
      <div class="animate-drift absolute left-[6%] top-44 size-40 rounded-full bg-primary-300/20 blur-3xl dark:bg-primary-600/10" />
      <div
        class="animate-drift absolute right-[4%] top-72 size-56 rounded-full bg-primary-500/15 blur-3xl dark:bg-primary-700/10"
        style="animation-delay: -4s"
      />
    </div>

    <div class="relative mx-auto max-w-6xl px-4 pb-20 pt-16 sm:pt-24">
      <!-- Hero:徽章 + 渐变标题 + 副标题 + CTA -->
      <div class="text-center">
        <p class="mx-auto inline-flex items-center gap-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 px-3.5 py-1.5 text-xs text-primary-600 dark:text-primary-400">
          <UIcon
            name="i-lucide-wand-sparkles"
            class="size-3.5"
          />
          AI 驱动 · 本地优先 · 世界观一致
        </p>
        <h1 class="mx-auto mt-6 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-highlighted sm:text-5xl">
          把一本小说,变成<br class="hidden sm:block"><span class="text-gradient">可走进的世界</span>
        </h1>
        <p class="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-lg">
          上传整本 TXT,AI 分章提取人物、地点、势力、规则与伏笔,自动合并校验后生成完整世界观——选择一个角色,真正走进故事。
        </p>
        <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
          <UButton
            color="primary"
            size="lg"
            icon="i-lucide-sparkles"
            @click="onHeroStart"
          >
            {{ loggedIn ? '开始新世界' : '登录后生成' }}
          </UButton>
          <UButton
            label="返回首页"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="outline"
            size="lg"
            to="/"
          />
        </div>
      </div>

      <!-- 主卡片:未登录引导 / 上传 / 生成中 / 完成 / 失败 -->
      <div
        ref="uploadCard"
        class="mx-auto mt-14 max-w-4xl scroll-mt-6 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm shadow-neutral-900/3 dark:border-neutral-800 dark:bg-neutral-900/60 sm:p-10"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".txt,.text"
          class="hidden"
          @change="onFileChosen"
        >

        <!-- 未登录引导 -->
        <div
          v-if="!loggedIn"
          class="py-6 text-center sm:py-10"
        >
          <div class="mx-auto flex size-14 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            <UIcon
              name="i-lucide-lock"
              class="size-6"
            />
          </div>
          <p class="mt-5 text-lg font-semibold text-highlighted">
            登录后即可生成世界
          </p>
          <p class="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            上传整本小说,由 AI 生成人物卡与完整世界观;生成结果可同步云端,换设备继续游玩。
          </p>
          <div class="mt-7 flex justify-center">
            <UButton
              color="primary"
              size="lg"
              icon="i-lucide-log-in"
              @click="requireLogin"
            >
              登录 / 注册
            </UButton>
          </div>
        </div>

        <!-- 上传(拖拽/选择) -->
        <div
          v-else-if="genState.phase === 'idle'"
          class="rounded-2xl border-2 border-dashed p-10 text-center transition-all duration-200 sm:p-14"
          :class="isDragging
            ? 'border-primary-500 bg-primary-500/4'
            : 'border-neutral-300/80 bg-neutral-50/50 dark:border-neutral-700/80 dark:bg-neutral-950/30'"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="onDrop"
        >
          <div class="mx-auto flex size-12 items-center justify-center rounded-xl bg-linear-to-br from-green-500/15 to-teal-500/15 text-primary-600 dark:text-primary-400">
            <UIcon
              name="i-lucide-upload"
              class="size-6"
            />
          </div>
          <p class="mt-5 text-base font-semibold text-highlighted">
            拖入整本 TXT,或点击选择文件
          </p>
          <p class="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            AI 分章提取人物、地点、势力、规则与伏笔,自动合并校验后生成可玩的世界观
          </p>
          <div class="mt-7 flex justify-center">
            <UButton
              color="primary"
              size="lg"
              icon="i-lucide-folder-open"
              :disabled="picking"
              @click="onPickFile"
            >
              {{ picking ? '正在读取…' : '选择 TXT 文件' }}
            </UButton>
          </div>
          <div class="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-neutral-400 dark:text-neutral-500">
            <span class="inline-flex items-center gap-1.5">
              <UIcon
                name="i-lucide-file-text"
                class="size-3.5"
              />
              支持 .txt 整本上传
            </span>
            <span class="inline-flex items-center gap-1.5">
              <UIcon
                name="i-lucide-list-checks"
                class="size-3.5"
              />
              自动分章与编码识别
            </span>
            <span class="inline-flex items-center gap-1.5">
              <UIcon
                name="i-lucide-shield-check"
                class="size-3.5"
              />
              正文不出设备
            </span>
          </div>
        </div>

        <!-- 生成前确认:书名 + 全书字数 + 下方小字预估消耗,确认后才进入生成 -->
        <div
          v-else-if="genState.phase === 'confirm'"
          class="space-y-6"
        >
          <UAlert
            v-if="quotaWarn?.insufficient"
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="Token 额度不足,可能生成失败"
            :description="`当前余额 ${quotaWarn.balance.toLocaleString()} tokens,预计至少需要 ${quotaWarn.needed.toLocaleString()} tokens(按全书字数与生成流水线估算)。建议切换节约模式,或到个人中心购买加油包、配置自己的 API Key。`"
          />

          <div class="flex items-center gap-3.5">
            <div class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-600 dark:bg-primary-400/10 dark:text-primary-400">
              <UIcon
                name="i-lucide-file-text"
                class="size-5"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="truncate text-sm font-semibold text-highlighted">
                  {{ pendingGen?.title }}
                </p>
                <UBadge
                  v-if="fromPreset"
                  color="info"
                  variant="soft"
                  size="sm"
                  label="预置小说"
                />
              </div>
              <p class="mt-0.5 text-xs text-neutral-500">
                {{ fromPreset ? '来自预置小说库 · ' : '' }}{{ pendingGen?.chapters.length }} 章 · 全书约 {{ formatChars(totalChars) }}
              </p>
            </div>
          </div>

          <!-- 预估消耗小字提示:按全书字数估算本次生成 token -->
          <div class="flex items-start gap-2 rounded-xl border border-neutral-200/70 bg-neutral-50/80 px-3.5 py-2.5 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400">
            <UIcon
              name="i-lucide-coins"
              class="mt-0.5 size-3.5 shrink-0"
            />
            <span>
              按全书 {{ formatChars(totalChars) }} 估算,本次生成预计消耗约
              <span class="font-semibold text-neutral-700 dark:text-neutral-200">{{ estimatedTokens.toLocaleString() }}</span>
              tokens(字数 × {{ ecoMode ? 1.2 : 1.5 }},实际以生成结果为准)
            </span>
          </div>

          <!-- 生成模式:完整(默认)/ 节约 -->
          <div class="flex flex-col items-center gap-2">
            <div class="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 p-1 dark:border-neutral-800 dark:bg-neutral-950/40">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors"
                :class="!ecoMode
                  ? 'bg-primary-500 text-white shadow-sm shadow-primary-500/30'
                  : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'"
                @click="ecoMode = false"
              >
                <UIcon
                  name="i-lucide-sparkles"
                  class="size-3.5"
                />
                完整模式
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors"
                :class="ecoMode
                  ? 'bg-primary-500 text-white shadow-sm shadow-primary-500/30'
                  : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'"
                @click="ecoMode = true"
              >
                <UIcon
                  name="i-lucide-leaf"
                  class="size-3.5"
                />
                节约模式
              </button>
            </div>
            <p class="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
              <UIcon
                :name="ecoMode ? 'i-lucide-leaf' : 'i-lucide-sparkles'"
                class="size-3.5"
              />
              <span v-if="ecoMode">节约模式:跳过 AI 一致性检查与人物卡润色,仅提取核心设定,约省 15%~25% token;人物卡更朴素</span>
              <span v-else>完整模式:含一致性检查与 AI 润色的人物卡,世界观还原更全</span>
            </p>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-3">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-rotate-ccw"
              @click="repickFile"
            >
              重新选择
            </UButton>
            <UButton
              color="primary"
              size="lg"
              icon="i-lucide-wand-sparkles"
              @click="startGenerationFromConfirm"
            >
              开始生成
            </UButton>
          </div>
        </div>

        <!-- 生成中 -->
        <div
          v-else-if="genState.phase === 'parsing' || genState.phase === 'generating'"
          class="space-y-7"
        >
          <UAlert
            v-if="quotaWarn?.insufficient"
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="Token 额度不足,可能生成失败"
            :description="`当前余额 ${quotaWarn.balance.toLocaleString()} tokens,预计至少需要 ${quotaWarn.needed.toLocaleString()} tokens(按全书字数与生成流水线估算)。建议先到个人中心购买加油包,或配置自己的 API Key。`"
          />

          <!-- 书名 + 实时消耗 -->
          <div class="flex items-center gap-3.5">
            <div class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-600 dark:bg-primary-400/10 dark:text-primary-400">
              <UIcon
                name="i-lucide-file-text"
                class="size-5"
              />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-highlighted">
                {{ genState.title }}
              </p>
              <p class="mt-0.5 text-xs text-neutral-500">
                {{ stageLabel[genState.progress?.stage ?? 'parse'] }}
                <template v-if="genState.progress?.stage === 'extract'">
                  {{ genState.progress.doneUnits }}/{{ genState.progress.totalUnits }} 单元
                </template>
              </p>
            </div>
            <div class="shrink-0 text-right">
              <p class="text-sm font-semibold text-primary-600 tabular-nums dark:text-primary-400">
                {{ liveShown.toLocaleString() }}
                <span class="text-xs font-normal text-neutral-400">tokens</span>
              </p>
            </div>
          </div>

          <!-- 阶段 stepper -->
          <div class="flex items-start">
            <template
              v-for="(s, i) in stages"
              :key="s.key"
            >
              <div class="flex w-14 flex-col items-center gap-1.5 sm:w-16">
                <div
                  class="flex size-7 items-center justify-center rounded-full text-[11px] transition-all duration-300"
                  :class="i < stageIndex
                    ? 'bg-primary-500 text-white shadow-sm shadow-primary-500/40'
                    : i === stageIndex
                      ? 'bg-primary-500/10 text-primary-600 ring-1 ring-primary-500/40 animate-pulse dark:bg-primary-400/10 dark:text-primary-400'
                      : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-600'"
                >
                  <UIcon
                    v-if="i < stageIndex"
                    name="i-lucide-check"
                    class="size-3.5"
                  />
                  <UIcon
                    v-else
                    :name="s.icon"
                    class="size-3.5"
                  />
                </div>
                <span
                  class="text-[11px] leading-tight"
                  :class="i === stageIndex
                    ? 'font-semibold text-primary-600 dark:text-primary-400'
                    : i < stageIndex
                      ? 'text-neutral-700 dark:text-neutral-300'
                      : 'text-neutral-400 dark:text-neutral-600'"
                >
                  {{ s.label }}
                </span>
              </div>
              <div
                v-if="i < stages.length - 1"
                class="mt-3.5 h-px flex-1 rounded-full transition-colors duration-300"
                :class="i < stageIndex ? 'bg-primary-500/60' : 'bg-neutral-200 dark:bg-neutral-800'"
              />
            </template>
          </div>

          <!-- 进度条 + 百分比 -->
          <div class="flex items-center gap-3">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
              <div
                class="h-full rounded-full bg-linear-to-r from-primary-500 to-teal-400 transition-[width] duration-500 ease-out"
                :style="{ width: `${genPercent}%` }"
              />
            </div>
            <span class="w-9 shrink-0 text-right text-xs font-semibold text-neutral-600 tabular-nums dark:text-neutral-300">
              {{ genPercent }}%
            </span>
          </div>

          <!-- 取消生成 -->
          <div class="flex justify-end">
            <UButton
              color="error"
              variant="outline"
              size="sm"
              icon="i-lucide-circle-stop"
              @click="cancelGeneration"
            >
              取消生成
            </UButton>
          </div>

          <!-- 阶段告警 -->
          <ul
            v-if="genState.progress?.warnings?.length"
            class="space-y-1"
          >
            <li
              v-for="(w, i) in genState.progress.warnings.slice(0, 3)"
              :key="i"
              class="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="mt-0.5 size-3.5 shrink-0"
              />
              {{ w }}
            </li>
          </ul>
        </div>

        <!-- 完成 -->
        <div
          v-else-if="genState.phase === 'done'"
          class="py-6 text-center sm:py-8"
        >
          <div class="mx-auto flex size-14 items-center justify-center rounded-full bg-primary-500/10 text-primary-500 ring-1 ring-primary-500/25">
            <UIcon
              name="i-lucide-circle-check"
              class="size-7"
            />
          </div>
          <p class="mt-5 text-lg font-semibold text-highlighted">
            《{{ genState.title }}》世界已生成
          </p>
          <div class="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs">
            <span
              v-if="resultWork?.author"
              class="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              <UIcon
                name="i-lucide-user-round"
                class="size-3.5"
              />
              {{ resultWork.author }}
            </span>
            <span
              v-if="resultWork?.chapters?.length"
              class="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              <UIcon
                name="i-lucide-book-open"
                class="size-3.5"
              />
              {{ resultWork.chapters.length }} 章
            </span>
            <span
              v-if="genState.tokensUsed"
              class="inline-flex items-center gap-1 rounded-full bg-primary-500/10 px-3 py-1 text-primary-700 dark:bg-primary-400/10 dark:text-primary-400"
            >
              <UIcon
                name="i-lucide-coins"
                class="size-3.5"
              />
              消耗 {{ genState.tokensUsed.toLocaleString() }} tokens
            </span>
          </div>
          <div class="mt-8 flex justify-center">
            <UButton
              color="primary"
              size="lg"
              icon="i-lucide-arrow-right"
              @click="navigateTo(`/play/${genState.resultId}`)"
            >
              选择角色进入故事
            </UButton>
          </div>
        </div>

        <!-- 失败 -->
        <div
          v-else
          class="py-6 text-center sm:py-10"
        >
          <div class="mx-auto flex size-14 items-center justify-center rounded-full bg-red-500/10 text-red-500">
            <UIcon
              name="i-lucide-triangle-alert"
              class="size-6"
            />
          </div>
          <p class="mt-5 text-lg font-semibold text-highlighted">
            生成失败
          </p>
          <p class="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {{ genState.error }}
          </p>
          <div class="mt-7 flex justify-center">
            <UButton
              color="primary"
              size="lg"
              icon="i-lucide-rotate-ccw"
              @click="onPickFile"
            >
              重新选择文件
            </UButton>
          </div>
        </div>
      </div>

      <!-- 四步流程 -->
      <section
        v-reveal
        class="border-t border-neutral-200/70 pt-20 dark:border-neutral-800/70"
      >
        <div class="mb-10 text-center">
          <p class="text-xs font-semibold tracking-widest text-primary-600 dark:text-primary-400">
            流程
          </p>
          <h2 class="mt-2 text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
            从一本小说到可玩的世界
          </h2>
          <p class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            四步完成,全程透明可查
          </p>
        </div>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="(step, i) in steps"
            :key="step.title"
            class="group relative overflow-hidden rounded-2xl border border-neutral-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-primary-500/40 hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-500)_30%,transparent)] dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30 dark:hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-400)_15%,transparent)]"
          >
            <span
              class="absolute right-5 top-3 text-4xl font-bold text-neutral-100 transition-colors duration-300 group-hover:text-primary-500/20 dark:text-neutral-800 dark:group-hover:text-primary-400/15"
              aria-hidden="true"
            >
              {{ `0${i + 1}` }}
            </span>
            <div class="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary-500/15 text-primary-600 dark:text-primary-400">
              <UIcon
                :name="step.icon"
                class="size-5"
              />
            </div>
            <h3 class="font-semibold text-highlighted">
              {{ step.title }}
            </h3>
            <p class="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              {{ step.desc }}
            </p>
          </div>
        </div>
      </section>

      <!-- 特性 -->
      <section
        v-reveal
        class="mt-16 grid gap-4 sm:grid-cols-3"
      >
        <div
          v-for="f in features"
          :key="f.title"
          class="group rounded-2xl border border-neutral-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-primary-500/40 hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-500)_30%,transparent)] dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30 dark:hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-400)_15%,transparent)]"
        >
          <div class="mb-3 flex size-10 items-center justify-center rounded-xl bg-linear-to-br from-primary-500/15 to-primary-400/15 text-primary-600 transition-transform duration-300 group-hover:scale-110 dark:text-primary-400">
            <UIcon
              :name="f.icon"
              class="size-5"
            />
          </div>
          <h3 class="font-semibold text-highlighted">
            {{ f.title }}
          </h3>
          <p class="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {{ f.desc }}
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
