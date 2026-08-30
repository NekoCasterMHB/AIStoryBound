<script setup lang="ts">
// /generate — 生成世界页(游客可见,但生成需要登录):未登录显示引导卡 + 弹出登录模态框;
// 登录后选择 TXT → 云端任务生成(原文上传 R2,Workflows 执行,客户端展示进度)→ 完成自动安装 → 跳选角页。
// 也支持预置小说详情页跳转(?from=preset&id=xxx&eco=0|1):自动加载该小说为附件,直接进入确认页由用户确认;
// 支持创意工坊「书架」购买的本地作品跳转(?from=work&id=xxx):从本地书架加载章节进入确认页。
// 相同 txt 的历史成书按内容哈希命中共享缓存:可拉取(扣记录消耗的一半)或重新生成(正常扣费并刷新缓存)。
import { parseLocalNovel, generateWorld, getWork } from '../utils/worldGen'
import { clearExtractCache } from '../utils/extractCache'
import { CancelledError } from '../utils/aiRelay'
import { checkWorldGenQuota, estimateWorldGenTokens } from '../utils/tokenQuota'
import { loadPresetChapters } from '../utils/chapters'
import { fetchPrebuiltWorld, installPrebuiltWork } from '../utils/prebuiltWorld'
import type { PrebuiltWorld } from '../utils/prebuiltWorld'
import { setAdultModeEnabled } from '../utils/adultMode'
import { getActiveRelayConfig } from '../utils/aiConfigStore'
import {
  hashFile, checkWorldDuplicate, uploadWorldGenTask, pullCachedWorld,
  pollWorldGenTask, downloadAndInstallWorldTask, cancelWorldGenTask
} from '../utils/worldGenCloud'
import type { WorldCacheHit, WorldGenTaskDTO } from '../utils/worldGenCloud'
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

/** 创意工坊「书架」购买小说安装到本地后的跳转目标(?from=work&id=xxx) */
const workSource = computed(() => {
  const from = route.query.from
  const id = route.query.id
  return from === 'work' && typeof id === 'string' && id.trim() ? id.trim() : null
})

/** 当前附件是否来自预置小说库(确认页展示来源徽章;改选其他文件/取消后清除) */
const fromPreset = ref(false)
/** 预置小说元数据作者:生成时直接采用,跳过联网识别(省 token) */
const presetAuthor = ref<string | null>(null)
/** 预置小说元数据(官方预生成世界组装作品用) */
const presetMeta = ref<PresetNovelRow | null>(null)
/** 官方预生成世界:存在时确认页提供 0 token 直接进入(自定义生成保留) */
const prebuiltWorld = ref<PrebuiltWorld | null>(null)
const directStarting = ref(false)

const toast = useToast()

const { data: session } = await useAuthSession()
const loggedIn = computed(() => !!session.value?.user)
const { requireLogin } = useAuthModal()

const resultWork = ref<LocalWork | null>(null)

// ---- 世界详情弹窗(完成页查看生成产物/编辑概览元数据) ----
const worldDetailOpen = ref(false)
const worldDetailWorkId = ref('')

function openWorldDetail(id: string) {
  if (!id) return
  worldDetailWorkId.value = id
  worldDetailOpen.value = true
}

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

/** 整体进度百分比:按阶段分段映射,全程单调递增(extract 内 15→80,之后逐段进位;云端上传期映射到 2→12%) */
const genPercent = computed(() => {
  if (cloudUploading.value) return Math.round(2 + cloudUploadPct.value * 0.1)
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

// ---- 云端任务生成(上传 txt 的默认路径;预置/本地作品入口保留原管线) ----

/** 原始 File(云端任务上传需要;确认页选定后保留,重新选择时清空) */
const cloudFile = ref<File | null>(null)
/** 文件内容 sha-256(选文件后异步计算;共享缓存查重键) */
const cloudHash = ref<string | null>(null)
/** 相同 txt 的历史成书(缓存命中时确认页提供「拉取已有世界」) */
const dupHit = ref<WorldCacheHit | null>(null)
const dupChecking = ref(false)
/** 云端任务快照(轮询更新)与上传进度 */
const cloudTask = ref<WorldGenTaskDTO | null>(null)
const cloudUploadPct = ref(0)
const pullingCached = ref(false)

/** 是否正在上传原文(已进入生成态但任务尚未创建) */
const cloudUploading = computed(() => genState.value.phase === 'generating' && !cloudTask.value && !!cloudFile.value)

/** 查重(选文件后与切换模式时触发;失败静默,不影响正常生成) */
async function refreshDupHit() {
  const file = cloudFile.value
  if (!file || fromPreset.value) {
    dupHit.value = null
    return
  }
  dupChecking.value = true
  try {
    const hash = cloudHash.value ?? await hashFile(file)
    cloudHash.value = hash
    dupHit.value = await checkWorldDuplicate(hash, ecoMode.value ? 'eco' : 'full')
  } catch {
    dupHit.value = null
  } finally {
    dupChecking.value = false
  }
}

watch(ecoMode, () => {
  if (genState.value.phase === 'confirm' && cloudFile.value) void refreshDupHit()
})

/** 云端任务快照 → 复用本地管线的进度对象(生成页 stepper/进度条/告警 UI 全部复用) */
function taskToProgress(t: WorldGenTaskDTO): GenerateProgress {
  return {
    stage: t.stage,
    doneUnits: t.stageDetail.doneUnits,
    totalUnits: t.stageDetail.totalUnits,
    tokensUsed: t.tokensUsed,
    liveTokens: t.tokensUsed,
    warnings: t.warnings,
    inflight: 0
  }
}

function resetCloudState() {
  cloudFile.value = null
  cloudHash.value = null
  dupHit.value = null
  cloudTask.value = null
  cloudUploadPct.value = 0
}

/** 确认页「开始生成」(上传 txt):云端任务路径 —— 上传 → 轮询 → 完成自动安装 */
async function startCloudGeneration() {
  const file = cloudFile.value
  if (!file) return
  const seq = ++runSeq
  genState.value.phase = 'generating'
  genState.value.progress = { stage: 'parse', doneUnits: 0, totalUnits: 0, tokensUsed: 0, liveTokens: 0, warnings: [], inflight: 0 }
  cloudTask.value = null
  cloudUploadPct.value = 0
  const ctrl = new AbortController()
  abortCtrl.value = ctrl
  try {
    // 自建 key 配置(本地已验证的激活配置)随任务上送云端加密暂存;平台模式为 null
    let config: { format: string, baseUrl: string, apiKey: string, model: string } | null = null
    try {
      config = await getActiveRelayConfig()
    } catch {
      config = null
    }
    const task = await uploadWorldGenTask({
      file,
      mode: ecoMode.value ? 'eco' : 'full',
      charCount: totalChars.value,
      config,
      onUploadProgress: (loaded, total) => {
        if (seq === runSeq) cloudUploadPct.value = Math.min(100, Math.round((loaded / total) * 100))
      }
    })
    if (seq !== runSeq) return
    cloudTask.value = task
    genState.value.progress = taskToProgress(task)
    const final = await pollWorldGenTask(task.id, (t) => {
      if (seq !== runSeq) return
      cloudTask.value = t
      genState.value.progress = taskToProgress(t)
    }, ctrl.signal)
    if (seq !== runSeq) return
    if (final.status !== 'completed') {
      throw new Error(final.error || (final.status === 'cancelled' ? '任务已取消' : '云端生成任务失败'))
    }
    // 完成即自动下载安装进本地书架
    const work = await downloadAndInstallWorldTask(final)
    if (seq !== runSeq) return
    genState.value.phase = 'done'
    genState.value.progress = null
    genState.value.resultId = work.id
    genState.value.tokensUsed = work.tokensUsed ?? final.tokensUsed
    resultWork.value = work
    abortCtrl.value = null
    lastFailedGen.value = null
    await clearExtractCache().catch(() => { /* 清缓存失败不影响结果展示 */ })
  } catch (err) {
    if (seq !== runSeq) return
    abortCtrl.value = null
    if (err instanceof DOMException && err.name === 'AbortError') return
    genState.value = {
      phase: 'error',
      title: genState.value.title,
      progress: null,
      error: err instanceof Error ? err.message : String(err),
      resultId: null,
      tokensUsed: cloudTask.value?.tokensUsed ?? 0
    }
  }
}

/** 确认页「拉取已有世界」:扣记录消耗的一半,直接下载安装进书架 */
async function startPullCached(hit: WorldCacheHit) {
  const seq = ++runSeq
  pullingCached.value = true
  try {
    const task = await pullCachedWorld(hit.cacheId)
    const work = await downloadAndInstallWorldTask(task)
    if (seq !== runSeq) return
    genState.value.phase = 'done'
    genState.value.progress = null
    genState.value.resultId = work.id
    genState.value.tokensUsed = task.tokensUsed
    genState.value.title = work.title
    resultWork.value = work
    lastFailedGen.value = null
  } catch (e) {
    if (seq !== runSeq) return
    toast.add({
      color: 'error',
      icon: 'i-lucide-triangle-alert',
      title: '拉取失败',
      description: e instanceof Error ? e.message : String(e)
    })
  } finally {
    pullingCached.value = false
  }
}

// 未登录访问:引导登录(不强制跳页)
const askingLogin = ref(false)
onMounted(async () => {
  // 本地作品跳转(创意工坊书架购买的小说):先引导登录,再加载本地章节,直接进入确认页
  if (workSource.value) {
    if (!loggedIn.value && !askingLogin.value) {
      askingLogin.value = true
      await requireLogin()
      askingLogin.value = false
    }
    if (route.query.eco === '1') ecoMode.value = true
    await loadWorkIntoConfirm(workSource.value)
    return
  }
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
  resetCloudState()
  const seq = ++runSeq
  // 重置平滑计数,开始新一轮展示
  cancelAnimationFrame(shownRaf)
  shownCur = 0
  liveShown.value = 0
  genState.value = { phase: 'parsing', title: file.name, progress: null, error: null, resultId: null, tokensUsed: 0 }
  // 重新上传/换文件:清空旧提取缓存(带超时,不阻塞解析)
  void clearExtractCache()
  try {
    const parsed = await parseLocalNovel(file)
    genState.value.title = parsed.title
    if (seq !== runSeq) return // 解析期间已被取消
    pendingGen.value = { title: parsed.title, chapters: parsed.chapters, frontMatter: parsed.frontMatter }
    // 生成前预检平台 token 额度(不足时提示,不阻断)
    quotaWarn.value = await checkWorldGenQuota(totalChars.value, { eco: ecoMode.value })
    // 云端任务:保留原始文件,异步计算哈希并查重(相同 txt 的历史成书可拉取)
    cloudFile.value = file
    cloudHash.value = null
    dupHit.value = null
    void refreshDupHit()
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
  prebuiltWorld.value = null
  presetMeta.value = null
  resetCloudState()
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
    presetMeta.value = meta
    // 拉取官方预生成世界(存在则确认页提供 0 token 直接进入;失败/未预生成不影响自定义生成)
    if (meta) {
      fetchPrebuiltWorld(presetId)
        .then((w) => { prebuiltWorld.value = w })
        .catch(() => { prebuiltWorld.value = null })
    }
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

/** 本地作品跳转场景(创意工坊「书架」购买的小说安装到本地后):从 IndexedDB 加载章节并进入确认页,与上传同一管线 */
async function loadWorkIntoConfirm(workId: string) {
  const seq = ++runSeq
  quotaWarn.value = null
  pendingGen.value = null
  fromPreset.value = false
  prebuiltWorld.value = null
  presetMeta.value = null
  resetCloudState()
  // 重置平滑计数,开始新一轮展示
  cancelAnimationFrame(shownRaf)
  shownCur = 0
  liveShown.value = 0
  genState.value = { phase: 'parsing', title: '本地作品', progress: null, error: null, resultId: null, tokensUsed: 0 }
  try {
    const work = await getWork(workId)
    if (seq !== runSeq) return // 加载期间已被取消
    if (!work || !work.chapters.length) {
      throw new Error('本地作品不存在或没有章节内容,请先在书架获取小说')
    }
    pendingGen.value = { title: work.title, chapters: work.chapters, frontMatter: '' }
    // 本地作品自带作者(商城购买的小说记录发布者填写):直接采用,跳过联网识别(省 token)
    presetAuthor.value = work.author ?? null
    genState.value.title = work.title
    // 先展示字数与预估消耗,用户确认后才进入生成管线
    genState.value.phase = 'confirm'
    quotaWarn.value = await checkWorldGenQuota(totalChars.value, { eco: ecoMode.value })
  } catch (err) {
    if (seq !== runSeq) return // 已取消或被新任务接管
    fromPreset.value = false
    genState.value = {
      phase: 'error',
      title: '本地作品',
      progress: null,
      error: err instanceof Error ? err.message : String(err),
      resultId: null,
      tokensUsed: 0
    }
  }
}

/** 生成失败时的参数快照:失败态"继续生成"直接复用(配合断点续跑缓存,已提取部分 0 token) */
const lastFailedGen = ref<{ title: string, chapters: ChapterSegment[], frontMatter: string } | null>(null)

async function runGeneration(title: string, chapters: Parameters<typeof generateWorld>[1], frontMatter: string, seq: number, knownAuthor?: string) {
  const ctrl = new AbortController()
  abortCtrl.value = ctrl
  genState.value.phase = 'generating'
  // 只认当前运行序号的进度回调,避免已取消管线的残留事件覆盖新任务状态
  const applyProgress = (p: GenerateProgress) => {
    if (seq === runSeq) genState.value.progress = { ...p }
  }
  try {
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
    lastFailedGen.value = null
    // 生成完成:清空提取缓存,防止多次生成后 IndexedDB 无限累加
    await clearExtractCache().catch(() => { /* 清缓存失败不影响结果展示 */ })
  } catch (err) {
    if (seq !== runSeq) return // 已被新任务接管
    abortCtrl.value = null
    // 用户取消:取消按钮已把状态复位为上传态,这里不覆盖
    if (err instanceof CancelledError) return
    // 其余失败(如提取失败率过高/成书失败)必须落到错误态,否则界面会一直停在"生成中";
    // 快照参数供"继续生成"续跑(断点续跑缓存会复用已提取单元,不重复消耗 token)
    lastFailedGen.value = { title, chapters, frontMatter }
    const lastProgress = genState.value.progress
    genState.value = {
      phase: 'error',
      title,
      progress: null,
      error: err instanceof Error ? err.message : String(err),
      resultId: null,
      // 保留最后估算的已消耗 token(失败不代表没扣费;断点续跑可复用已提取单元)
      tokensUsed: lastProgress?.liveTokens ?? genState.value.tokensUsed
    }
  }
}

/** 失败态"继续生成":复用失败时的参数重跑管线;extract 缓存会自动跳过已完成单元 */
function retryGeneration() {
  const pending = lastFailedGen.value
  if (!pending) return
  const seq = ++runSeq
  void runGeneration(pending.title, pending.chapters, pending.frontMatter, seq, presetAuthor.value ?? undefined)
}

/** 确认页"开始生成":上传 txt 走云端任务;预置/本地作品入口保留浏览器端管线 */
function startGenerationFromConfirm() {
  if (cloudFile.value) {
    void startCloudGeneration()
    return
  }
  const pending = pendingGen.value
  if (!pending) return
  pendingGen.value = null
  const seq = ++runSeq
  void runGeneration(pending.title, pending.chapters, pending.frontMatter, seq, presetAuthor.value ?? undefined)
}

/** 确认页"直接开始":用官方预生成世界组装作品落书架,0 token 跳选角(自定义生成保留) */
async function startPrebuiltFromConfirm() {
  const world = prebuiltWorld.value
  const meta = presetMeta.value
  if (!world || !meta) return
  directStarting.value = true
  try {
    const workId = await installPrebuiltWork(meta, world)
    // 预置小说进入世界默认开启成人模式(选角页可关)
    setAdultModeEnabled(true)
    await navigateTo(`/play/${workId}`)
  } catch (e) {
    toast.add({ color: 'error', icon: 'i-lucide-triangle-alert', title: '进入失败', description: e instanceof Error ? e.message : String(e) })
  } finally {
    directStarting.value = false
  }
}

/** 确认页"重新选择":回到上传态并直接打开文件选择 */
function repickFile() {
  pendingGen.value = null
  quotaWarn.value = null
  fromPreset.value = false
  presetAuthor.value = null
  prebuiltWorld.value = null
  presetMeta.value = null
  lastFailedGen.value = null
  resetCloudState()
  genState.value = { phase: 'idle', title: '', progress: null, error: null, resultId: null, tokensUsed: 0 }
  onPickFile()
}

/** 取消生成:中止在途调用、取消云端任务、作废当前管线并回到上传态 */
async function cancelGeneration() {
  runSeq++
  abortCtrl.value?.abort()
  abortCtrl.value = null
  // 云端任务:通知服务端取消(Workflow 终止 + 按实耗结算)
  const taskId = cloudTask.value?.id
  if (taskId) {
    void cancelWorldGenTask(taskId).catch(() => { /* 取消失败不影响界面复位 */ })
  }
  pendingGen.value = null
  quotaWarn.value = null
  fromPreset.value = false
  presetAuthor.value = null
  prebuiltWorld.value = null
  presetMeta.value = null
  lastFailedGen.value = null
  resetCloudState()
  genState.value = { phase: 'idle', title: '', progress: null, error: null, resultId: null, tokensUsed: 0 }
  // 取消后清空提取缓存,防止多次取消残留累计
  await clearExtractCache().catch(() => { /* 清缓存失败不影响状态复位 */ })
  toast.add({
    title: '已停止生成',
    description: '在途请求可能已产生少量扣费,可重新上传开始。',
    color: 'neutral',
    icon: 'i-lucide-circle-stop'
  })
}

/** 底部"四步流程"卡片数据 */
const steps = [
  { icon: 'i-lucide-file-up', title: '上传小说', desc: '拖入或选择整本 TXT,本地解析编码、清洗正文' },
  { icon: 'i-lucide-boxes', title: '提取世界观', desc: 'AI 分块并发提取人物、地点、势力、规则与伏笔' },
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
          上传整本 TXT,AI 分块提取人物、地点、势力、规则与伏笔,自动合并校验后生成完整世界观——选择一个角色,真正走进故事。
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
          @cancel="picking = false"
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
            AI 分块提取人物、地点、势力、规则与伏笔,自动合并校验后生成可玩的世界观
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
              自动编码识别与清洗
            </span>
            <span class="inline-flex items-center gap-1.5">
              <UIcon
                name="i-lucide-cloud-cog"
                class="size-3.5"
              />
              云端执行,可离开页面
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
            :description="`当前余额 ${quotaWarn.balance.toLocaleString()} tokens,预计至少需要 ${quotaWarn.needed.toLocaleString()} tokens(按全书字数估算)。建议切换节约模式,或到个人中心购买加油包、配置自己的 API Key。`"
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
                {{ fromPreset ? '来自预置小说库 · ' : '' }}全书约 {{ formatChars(totalChars) }}
              </p>
            </div>
          </div>

          <!-- 官方预生成世界:直接进入 0 token(自定义生成保留) -->
          <div
            v-if="fromPreset && prebuiltWorld"
            class="flex flex-col items-center gap-3 rounded-xl border border-primary-300/60 bg-primary-500/10 px-3.5 py-3 sm:flex-row sm:justify-between dark:border-primary-700/60"
          >
            <div class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <UIcon
                name="i-lucide-zap"
                class="size-4 shrink-0 text-primary-500"
              />
              <span>
                本书已有官方预生成世界,<span class="font-semibold">0 token 直接进入</span>(本页自定义生成按全书估算约 {{ estimatedTokens.toLocaleString() }} tokens)
              </span>
            </div>
            <UButton
              color="primary"
              icon="i-lucide-play"
              :loading="directStarting"
              @click="startPrebuiltFromConfirm"
            >
              直接开始
            </UButton>
          </div>

          <!-- 相同 txt 的历史成书:可拉取(扣记录消耗的一半)或重新生成 -->
          <div
            v-if="dupHit && cloudFile"
            class="flex flex-col gap-3 rounded-xl border border-teal-300/60 bg-teal-500/5 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-teal-700/60"
          >
            <div class="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <UIcon
                name="i-lucide-database-zap"
                class="mt-0.5 size-4 shrink-0 text-teal-500"
              />
              <div>
                <p>
                  已有人生成过这本相同内容的世界<span v-if="dupHit.title">《{{ dupHit.title }}》</span>(记录消耗 {{ dupHit.tokensUsed.toLocaleString() }} tokens)
                </p>
                <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  直接拉取成书仅需 {{ dupHit.halfCost.toLocaleString() }} tokens(记录消耗的一半);选择下方「开始生成」则重新生成并刷新缓存。
                </p>
              </div>
            </div>
            <UButton
              color="success"
              icon="i-lucide-cloud-download"
              :loading="pullingCached"
              class="shrink-0"
              @click="startPullCached(dupHit)"
            >
              拉取已有世界
            </UButton>
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
              tokens
            </span>
          </div>

          <!-- 云端生成说明(仅上传 txt 的确认页) -->
          <p
            v-if="cloudFile"
            class="flex items-start gap-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
          >
            <UIcon
              name="i-lucide-cloud"
              class="mt-0.5 size-3.5 shrink-0"
            />
            <span>
              云端生成:原文将上传至服务器执行(自建 Key 会加密暂存、任务结束即删除),生成期间可离开页面,进度也会显示在书架;
              相同文本的成书结果进入共享缓存,完成结果可打包下载。
            </span>
          </p>

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
            :description="`当前余额 ${quotaWarn.balance.toLocaleString()} tokens,预计至少需要 ${quotaWarn.needed.toLocaleString()} tokens(按全书字数估算)。建议先到个人中心购买加油包,或配置自己的 API Key。`"
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
              <div class="flex items-center gap-2">
                <p class="truncate text-sm font-semibold text-highlighted">
                  {{ genState.title }}
                </p>
                <UBadge
                  v-if="cloudFile"
                  color="info"
                  variant="soft"
                  size="sm"
                  label="云端任务"
                />
              </div>
              <p class="mt-0.5 text-xs text-neutral-500">
                <template v-if="cloudUploading">
                  上传原文 {{ cloudUploadPct }}%…
                </template>
                <template v-else>
                  {{ stageLabel[genState.progress?.stage ?? 'parse'] }}
                  <template v-if="genState.progress?.stage === 'extract'">
                    {{ genState.progress.doneUnits }}/{{ genState.progress.totalUnits }} 单元
                  </template>
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

          <!-- 高级详情:阶段/单元/告警即时可见,避免卡在 15% 时只能看进度条 -->
          <div class="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-400">
            <p class="font-medium text-neutral-700 dark:text-neutral-300">
              高级详情
              <span class="ms-1 font-normal text-neutral-500">
                {{ genState.progress?.stage ?? 'parse' }}
                · {{ genState.progress?.doneUnits ?? 0 }}/{{ genState.progress?.totalUnits ?? 0 }} 单元
                · 进行中 {{ genState.progress?.inflight ?? 0 }}
                · 分段 {{ (genState.progress?.unitMaxChars ?? 0).toLocaleString() }} 字
                · 已入账 {{ (genState.progress?.tokensUsed ?? 0).toLocaleString() }} / 估算 {{ liveShown.toLocaleString() }} tokens
              </span>
            </p>
            <p
              v-if="genState.progress?.debugHint"
              class="mt-1"
            >
              {{ genState.progress.debugHint }}
            </p>
            <ul
              v-if="genState.progress?.warnings?.length"
              class="mt-2 max-h-40 space-y-1 overflow-y-auto"
            >
              <li
                v-for="(w, i) in genState.progress.warnings.slice(-12)"
                :key="i"
                class="break-all text-amber-700 dark:text-amber-400"
              >
                {{ w }}
              </li>
            </ul>
            <p
              v-else
              class="mt-1 text-neutral-400"
            >
              暂无告警。若进度停在 15% 且估算 tokens 一直为 0,多半是上游请求尚未返回或被拒绝。
            </p>
          </div>
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
              全书约 {{ formatChars(resultWork.chapters.reduce((n, c) => n + c.content.length, 0)) }}
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
          <p
            v-if="resultWork?.overlay?.summary"
            class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400"
          >
            {{ resultWork.overlay.summary }}
          </p>
          <p
            v-if="resultWork?.overlay?.setting || resultWork?.overlay?.orientation"
            class="mx-auto mt-3 max-w-lg text-sm text-neutral-600 dark:text-neutral-400"
          >
            <span v-if="resultWork.overlay.orientation">{{ resultWork.overlay.orientation }}</span>
            <span v-if="resultWork.overlay.orientation && resultWork.overlay.heat"> · </span>
            <span v-if="resultWork.overlay.heat">{{ resultWork.overlay.heat }}</span>
            <span v-if="resultWork.overlay.setting"> · {{ resultWork.overlay.setting }}</span>
          </p>
          <div
            v-if="resultWork?.overlay?.tags?.length"
            class="mt-3 flex flex-wrap items-center justify-center gap-1.5"
          >
            <UBadge
              v-for="tag in resultWork.overlay.tags.slice(0, 12)"
              :key="tag"
              color="primary"
              variant="subtle"
              size="sm"
            >
              {{ tag }}
            </UBadge>
            <UBadge
              v-if="resultWork.overlay.tags.length > 12"
              color="neutral"
              variant="subtle"
              size="sm"
            >
              +{{ resultWork.overlay.tags.length - 12 }}
            </UBadge>
          </div>
          <details
            v-if="resultWork?.storyline?.length"
            class="mx-auto mt-5 max-w-xl text-left"
          >
            <summary class="cursor-pointer text-center text-sm text-neutral-500">
              故事线 · {{ resultWork.storyline.length }} 段
            </summary>
            <ol class="mt-3 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
              <li
                v-for="beat in resultWork.storyline"
                :key="beat.index"
              >
                <span class="font-medium text-highlighted">段{{ beat.index + 1 }}</span>
                {{ beat.summary }}
              </li>
            </ol>
          </details>
          <div class="mt-8 flex flex-wrap justify-center gap-3">
            <UButton
              color="primary"
              size="lg"
              icon="i-lucide-arrow-right"
              @click="navigateTo(`/play/${genState.resultId}`)"
            >
              选择角色进入故事
            </UButton>
            <UButton
              color="neutral"
              size="lg"
              variant="outline"
              icon="i-lucide-globe"
              @click="openWorldDetail(genState.resultId!)"
            >
              查看世界详情
            </UButton>
            <UButton
              color="neutral"
              size="lg"
              variant="outline"
              icon="i-lucide-library"
              to="/works"
            >
              返回书架
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
          <p
            v-if="genState.tokensUsed"
            class="mx-auto mt-3 max-w-md text-xs text-neutral-500"
          >
            本次已消耗约 {{ genState.tokensUsed.toLocaleString() }} tokens(估算);已提取的单元已缓存,「继续生成」可复用,不重复扣费。
          </p>
          <div class="mt-7 flex justify-center gap-3">
            <UButton
              v-if="lastFailedGen"
              color="primary"
              size="lg"
              icon="i-lucide-play"
              @click="retryGeneration"
            >
              继续生成(已提取部分自动复用)
            </UButton>
            <UButton
              color="neutral"
              size="lg"
              variant="outline"
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

    <!-- 世界详情弹窗(完成页入口) -->
    <WorldDetailModal
      v-model:open="worldDetailOpen"
      :work-id="worldDetailWorkId"
    />
  </div>
</template>
