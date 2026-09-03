<script setup lang="ts">
// /works — 我的书架(登录后):推荐书架(预置小说,可直接生成)+ 个人书架(本地作品 + 云端作品 + 继续游戏)
import type { TabsItem, DropdownMenuItem } from '@nuxt/ui'
import { listWorks, getWork, saveWork, deleteWork, parseLocalNovel, toContentSegments, isLegacyChapteredWork } from '../utils/worldGen'
import { NOVEL_ENCODING_LABELS } from '#shared/novel-encoding'
import { characterArcCandidates } from '#shared/world-build'
import { listLocalGames, deleteLocalGame } from '../utils/gameStore'
import { deleteGamePoints } from '../utils/gameSaveStore'
import { importWorkFromZip, downloadWorkAsZip } from '../utils/shareZip'
import { downloadWorkAsTxt, downloadGameAsTxt } from '../utils/exportStory'
import {
  fetchBackups, fetchBackupMeta, uploadWorkBackup, downloadWorkBackup, deleteCloudBackup,
  buildWorkBackupZip, parseWorkBackupZip, importBackupData, MAX_BACKUP_BYTES,
  type CloudBackupMeta
} from '../utils/backupStore'
import { listReadingProgress } from '../utils/readingStore'
import { fetchPrebuiltWorld, installPrebuiltWork } from '../utils/prebuiltWorld'
import type { PrebuiltWorld } from '../utils/prebuiltWorld'
import { setAdultModeEnabled } from '../utils/adultMode'
import { getActiveRelayConfig } from '../utils/aiConfigStore'
import {
  fetchWorldGenTasks, cancelWorldGenTask, downloadAndInstallWorldTask,
  resumeWorldGenTask, worldGenTaskPercent, worldGenStageLabel,
  startSupplementArcsTask, fetchArcsResult
} from '../utils/worldGenCloud'
import type { WorldGenTaskDTO } from '../utils/worldGenCloud'
import { type LocalWork, type LocalGame, type PresetNovelRow, type ReadingProgress, type ChapterSegment, uuid } from '#shared/novel'

useHead({ title: 'AI Word2World · 我的书架' })

const works = ref<LocalWork[]>([])
const games = ref<Awaited<ReturnType<typeof listLocalGames>>>([])
/** 云端备份(每作品整包:作品+游戏会话+存盘点;与本地作品按 workId 对应) */
const backups = ref<CloudBackupMeta[]>([])
const backupsLoaded = ref(false)

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

/** 阅读进度徽章:null = 未读过;单段全文(无章节)只显示"已开始" */
function readBadge(p: ReadingProgress | undefined): { label: string, color: 'success' | 'info' } | null {
  if (!p) return null
  return p.finished
    ? { label: '已读完', color: 'success' }
    : { label: p.chapterIndex > 0 ? `读到第 ${p.chapterIndex + 1} 章` : '已开始', color: 'info' }
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

// ---- 旧版分章格式作品:开始新游戏前提示重新生成 ----
// 旧版按章节标题切分存储(多段);新版统一单段全文。旧的"无章节 txt"旧版也存单段,无差异不提示。
const legacyStartWork = ref<LocalWork | null>(null)
const legacyStartOpen = computed({
  get: () => legacyStartWork.value !== null,
  set: (v: boolean) => { if (!v) legacyStartWork.value = null }
})

function selectRole(w: LocalWork) {
  if (isLegacyChapteredWork(w)) {
    legacyStartWork.value = w
    return
  }
  void navigateTo(`/play/${w.id}`)
}

function legacyStartRegenerate() {
  const id = legacyStartWork.value?.id
  legacyStartWork.value = null
  if (id) void navigateTo(`/generate?from=work&id=${id}`)
}

function legacyStartProceed() {
  const id = legacyStartWork.value?.id
  legacyStartWork.value = null
  if (id) void navigateTo(`/play/${id}`)
}

onMounted(() => {
  void refreshLocal()
  void loadOfficialWorks()
  void loadReadingProgress()
  void loadBackups()
  void loadCloudTasks()
})

// ---- 云端备份(按作品整包:作品+游戏会话+存盘点 ZIP 上传 R2,D1 记元数据;书架唯一云端同步入口) ----
const syncingWorkId = ref<string | null>(null)
const restoringBackupId = ref<string | null>(null)

async function loadBackups() {
  backups.value = await fetchBackups()
  backupsLoaded.value = true
}

/** 本地作品是否有比云端备份更新的改动(有 → 作品卡显示「有更新待同步」) */
function backupStale(work: LocalWork): boolean {
  const b = backups.value.find(x => x.workId === work.id)
  if (!b) return false
  return (work.updatedAt ?? work.createdAt) > (b.workUpdatedAt ?? '')
}

/** 同步到云端:先查同 id 是否传过,传过则显示上次上传时间并确认覆盖 */
async function syncWorkToCloudZip(work: LocalWork) {
  if (syncingWorkId.value) return
  syncingWorkId.value = work.id
  try {
    const existing = await fetchBackupMeta(work.id)
    if (existing) {
      const ok = await askOverwriteModal(
        '覆盖云端备份',
        `《${work.title}》上次上传时间:${fmtTime(existing.uploadedAt)}。重新上传会把作品、${existing.gameCount ?? '全部'} 个游戏会话与存盘点打包,覆盖云端旧备份,确定继续?`
      )
      if (!ok) return
    }
    const { zip, meta } = await buildWorkBackupZip(work.id)
    if (zip.byteLength > MAX_BACKUP_BYTES) {
      toast.add({ title: '备份包过大,无法上传', color: 'error' })
      return
    }
    await uploadWorkBackup(zip, meta)
    work.syncStatus = 'synced'
    await saveWork(work)
    await Promise.all([refreshLocal(), loadBackups()])
    toast.add({ title: '已同步到云端', description: '作品、游戏会话与存盘点已完整备份', color: 'success' })
  } catch (e) {
    toast.add({ title: '同步失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    syncingWorkId.value = null
  }
}

/** 下载云端备份到本机:自动解压导入;本地已有同 id 作品 → 确认覆盖(保留现有则跳过作品,仍导入其游戏) */
async function restoreBackup(b: CloudBackupMeta) {
  if (restoringBackupId.value) return
  restoringBackupId.value = b.workId
  try {
    const bundle = parseWorkBackupZip(await downloadWorkBackup(b.workId))
    const existing = await getWork(bundle.work.id)
    let includeWork = true
    if (existing) {
      const ok = await askOverwriteModal(
        '恢复云端备份',
        `本地已有《${existing.title}》。是否用云端备份覆盖它(上次上传:${fmtTime(b.uploadedAt)})?选择「保留现有」则跳过作品,仍导入该作品下的游戏会话与存盘点。`
      )
      includeWork = ok
    }
    await importBackupData(bundle, { includeWork })
    await refreshLocal()
    toast.add({
      title: '已恢复到本机',
      description: `《${bundle.work.title}》${bundle.games.length ? `及 ${bundle.games.length} 个游戏会话` : ''}已导入,可在「继续游戏」中进入`,
      color: 'success'
    })
  } catch (e) {
    toast.add({ title: '恢复失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    restoringBackupId.value = null
  }
}

// ---- 删除云端备份(二次确认) ----
const backupDeleteOpen = ref(false)
const backupDeleteTarget = ref<CloudBackupMeta | null>(null)

function askDeleteBackup(b: CloudBackupMeta) {
  backupDeleteTarget.value = b
  backupDeleteOpen.value = true
}

async function confirmDeleteBackup() {
  const b = backupDeleteTarget.value
  if (!b) return
  try {
    await deleteCloudBackup(b.workId)
    await loadBackups()
    toast.add({ title: '已删除云端备份', color: 'neutral' })
  } catch (e) {
    toast.add({ title: '删除失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    backupDeleteOpen.value = false
    backupDeleteTarget.value = null
  }
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

/** 卡片标签:性向单独徽章展示(语义不同),这里返回玩法/标签,全部展示不截断 */
function workCardTags(w: LocalWork): string[] {
  const tags: string[] = []
  for (const k of w.overlay?.kinkProfile ?? []) {
    if (k.theme && !tags.includes(k.theme)) tags.push(k.theme)
  }
  for (const t of w.overlay?.tags ?? []) {
    if (t && !tags.includes(t)) tags.push(t)
  }
  return tags
}

/** 每部本地作品的「更多操作」菜单:世界详情 / 编辑正文 / 编辑角色卡 / 重新生成世界 / 同步云端 / 删除 */
function workMenuItems(w: LocalWork): DropdownMenuItem[][] {
  const firstGroup: DropdownMenuItem[] = [
    { label: '世界详情', icon: 'i-lucide-globe', onSelect: () => openWorldDetail(w.id) },
    { label: w.chapters.length === 0 ? '补全正文' : '编辑正文', icon: 'i-lucide-pencil', onSelect: () => navigateTo(`/edit/${w.id}`) },
    { label: '编辑角色卡', icon: 'i-lucide-users', onSelect: () => openCharEditor(w.id) },
    { label: '重新生成世界', icon: 'i-lucide-refresh-cw', onSelect: () => navigateTo(`/generate?from=work&id=${w.id}`) },
    { label: '同步云端', icon: 'i-lucide-cloud-upload', disabled: syncingWorkId.value === w.id, onSelect: () => syncWorkToCloudZip(w) }
  ]
  // 仅当真正缺少配角故事线且有候选角色(登场≥2次)时才展示增量补生成入口;
  // 缺 arcs 但无候选角色时点击只会提示"无需生成",不再浪费菜单位置
  if (
    !(w.characterArcs ?? []).length
    && (w.storyline?.length ?? 0) > 0
    && !!w.entities
    && characterArcCandidates(w.entities, w.storyline).length > 0
  ) {
    firstGroup.push({
      label: '补充生成配角故事线',
      icon: 'i-lucide-route',
      disabled: supplementingArcsId.value === w.id || !!activeArcsTask(w.id),
      onSelect: () => supplementWorkArcs(w)
    })
  }
  return [
    firstGroup,
    [
      { label: '导出原文 TXT', icon: 'i-lucide-file-text', onSelect: () => onExportWorkTxt(w) },
      { label: '导出游玩对话 TXT', icon: 'i-lucide-scroll-text', onSelect: () => openExportSession(w) },
      { label: '导出全部 ZIP', icon: 'i-lucide-file-archive', onSelect: () => onExportWorkZip(w) }
    ],
    [
      { label: '删除', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => askDeleteWork(w) }
    ]
  ]
}

// ---- 导出(原文 TXT / 全部 ZIP,与「导入 ZIP 分享包」配套) ----
function onExportWorkTxt(w: LocalWork) {
  const ok = downloadWorkAsTxt({ title: w.title, chapters: w.chapters })
  if (!ok) toast.add({ title: '作品没有正文,无法导出', color: 'warning' })
}

function onExportWorkZip(w: LocalWork) {
  downloadWorkAsZip({ work: w, games: games.value.filter(g => g.workId === w.id) })
}

// ---- 导出游玩对话 TXT:菜单 → 会话选择弹窗 → 下载该会话旁白剧情(与旧「分享剧情」同款) ----
const exportSessionOpen = ref(false)
const exportSessionWork = ref<LocalWork | null>(null)
/** 该作品全部会话(按角色分组、组内按最后游玩倒序) */
const exportSessionGroups = computed(() => {
  const gs = (exportSessionWork.value
    ? games.value.filter(g => g.workId === exportSessionWork.value!.id)
    : [])
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const byChar = new Map<string, LocalGame[]>()
  for (const g of gs) {
    const list = byChar.get(g.characterName) ?? []
    list.push(g)
    byChar.set(g.characterName, list)
  }
  return [...byChar.entries()].map(([name, list]) => ({ name, list }))
})

/** 会话回合数 = 旁白条数(每回合一条旁白) */
function turnsOf(g: LocalGame): number {
  return g.messages.filter(m => m.role !== 'user').length
}

function openExportSession(w: LocalWork) {
  exportSessionWork.value = w
  exportSessionOpen.value = true
}

function exportSessionTxt(g: LocalGame) {
  const work = exportSessionWork.value
  if (!work) return
  const ok = downloadGameAsTxt({
    title: work.title,
    playerName: g.characterName,
    messages: g.messages
  })
  if (!ok) toast.add({ title: '该会话还没有可导出的剧情', description: '先产生一段旁白后再导出', color: 'warning' })
}

// ---- 增量补生成配角故事线(旧作品补齐)→ 云端任务(kind=arcs,逐单元生成,进度条 + 手动写回) ----
const supplementingArcsId = ref<string | null>(null)
/** 本次会话创建的 arcs 任务 id:监听其在 cloudTasks 轮询中的终态并 toast */
const pendingArcsTaskId = ref<string | null>(null)

/** 该作品是否有进行中的补充故事线任务(卡片 loading 徽章 + 菜单防重) */
function activeArcsTask(workId: string): WorldGenTaskDTO | undefined {
  return cloudTasks.value.find(t => t.kind === 'arcs' && t.sourceWorkId === workId
    && (t.status === 'uploaded' || t.status === 'running' || t.status === 'paused'))
}

async function supplementWorkArcs(w: LocalWork) {
  if (supplementingArcsId.value) return
  if (activeArcsTask(w.id)) {
    toast.add({ title: '该作品已有进行中的补充故事线任务', description: '可先取消或等待完成', color: 'warning' })
    return
  }
  // 候选预检(与云端同一名单):无候选角色直接提示,不建任务
  if (!w.entities || !w.storyline?.length || characterArcCandidates(w.entities, w.storyline).length === 0) {
    toast.add({ title: '故事线中没有登场两次以上的角色,无需生成配角故事线', color: 'warning' })
    return
  }
  supplementingArcsId.value = w.id
  try {
    const task = await startSupplementArcsTask({
      workId: w.id,
      title: w.title || '未命名小说',
      entities: w.entities,
      storyline: w.storyline,
      text: w.chapters.map(c => c.content).join('\n'),
      config: await getActiveRelayConfig() ?? undefined
    })
    pendingArcsTaskId.value = task.id
    await loadCloudTasks()
    toast.add({
      title: '已创建云端任务,正在生成配角故事线…',
      description: `共 ${task.stageDetail.totalUnits} 条故事线,生成中可离开页面;完成后在任务卡片点「更新世界情报」写回作品`,
      color: 'info'
    })
  } catch (e) {
    toast.add({ title: '创建任务失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    supplementingArcsId.value = null
  }
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

// ---- 云端生成任务(进度条轮询;安装由用户手动点击,防同一任务被多处自动安装出重复成书) ----
const cloudTasks = ref<WorldGenTaskDTO[]>([])
const cloudTasksLoaded = ref(false)
let cloudPollTimer: ReturnType<typeof setInterval> | null = null

const hasActiveCloudTasks = computed(() =>
  cloudTasks.value.some(t => t.status === 'uploaded' || t.status === 'running'))

/** 云端任务模态框开关(个人书架入口按钮;任务详情全部收进模态框) */
const cloudTasksOpen = ref(false)
/** 有进行中的任务(含暂停待结算):入口按钮显示 loading 动画 */
const cloudTaskBusy = computed(() =>
  cloudTasks.value.some(t => t.status === 'uploaded' || t.status === 'running' || t.status === 'paused'))
/** 已完成且仍需处理的任务数(入口按钮角标):整书任务已安装/arcs 已写回的剔除 */
const completedCloudTaskCount = computed(() =>
  cloudTasks.value.filter((t) => {
    if (t.status !== 'completed') return false
    return t.kind === 'arcs' ? !appliedArcsTaskIds.value[t.id] : !taskInstalled(t)
  }).length)

function openCloudTasks() {
  // 任务模态框渲染在「个人书架」tab 内:从其它 tab 点开时先切过去,模态框才能弹出
  activeTab.value = 'personal'
  cloudTasksOpen.value = true
  // 打开即刷新任务状态(已完成/进度)
  void loadCloudTasks()
}

async function loadCloudTasks() {
  try {
    cloudTasks.value = await fetchWorldGenTasks()
    cloudTasksLoaded.value = true
  } catch {
    // 未登录/网络失败:静默(书架本身要求登录,此处仅容错)
  }
}

/** 下载成书 zip 并安装进本地书架(仅任务卡「下载安装」按钮手动触发;已装过同一任务则确认是否覆盖) */
const installingTaskId = ref<string | null>(null)
/** 本次下载是否命中已安装作品及用户选择:null=首次安装,true=覆盖,false=保留现有 */
let duplicateDecision: boolean | null = null

async function installCloudTask(t: WorldGenTaskDTO) {
  if (installingTaskId.value) return
  installingTaskId.value = t.id
  duplicateDecision = null
  try {
    const work = await downloadAndInstallWorldTask(t, {
      onDuplicate: async (existing) => {
        const overwrite = await askOverwriteCloudTask(existing)
        duplicateDecision = overwrite
        return overwrite
      }
    })
    await refreshLocal()
    if (duplicateDecision === null) {
      toast.add({ title: '云端世界已安装', description: `《${work.title}》已加入本地书架`, color: 'success' })
    } else if (duplicateDecision) {
      toast.add({ title: '已覆盖更新', description: `《${work.title}》已用最新内容覆盖`, color: 'success' })
    } else {
      toast.add({ title: '已跳过', description: '保留本地已有作品,未重复添加', color: 'neutral' })
    }
    // 安装/覆盖成功且确实是新安装:询问是否删除云端任务记录(已安装态由 sourceTaskId 判定)
    if (duplicateDecision !== false) {
      const remove = await askDeleteTaskModal(work.title)
      if (remove) {
        try {
          await cancelWorldGenTask(t.id)
          await loadCloudTasks()
        } catch {
          toast.add({ title: '删除任务记录失败', description: '本地书架不受影响,可稍后在任务卡片手动删除', color: 'warning' })
        }
      }
    }
  } catch (e) {
    toast.add({ title: '下载安装失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    installingTaskId.value = null
    duplicateDecision = null
  }
}

/** 云端任务是否已安装进书架(有本地作品的 sourceTaskId 指向该任务) */
function taskInstalled(t: WorldGenTaskDTO): boolean {
  return works.value.some(w => w.sourceTaskId === t.id)
}

// ---- arcs 任务结果写回(任务卡「更新世界情报」:拉取弧线并写入本地作品 characterArcs) ----
const applyingArcsTaskId = ref<string | null>(null)
/** 本次会话已写回过的 arcs 任务(按钮切「已更新」禁用,避免重复覆盖) */
const appliedArcsTaskIds = ref<Record<string, boolean>>({})

async function applyArcsResult(t: WorldGenTaskDTO) {
  if (applyingArcsTaskId.value || appliedArcsTaskIds.value[t.id]) return
  applyingArcsTaskId.value = t.id
  try {
    const arcs = await fetchArcsResult(t.id)
    if (!t.sourceWorkId) throw new Error('任务缺少作品信息')
    const work = await getWork(t.sourceWorkId)
    if (!work) throw new Error('本地未找到对应作品,可能已被删除')
    work.characterArcs = arcs
    work.updatedAt = new Date().toISOString()
    await saveWork(work)
    appliedArcsTaskIds.value[t.id] = true
    await refreshLocal()
    toast.add({ title: '世界情报已更新', description: `已写入 ${arcs.length} 条配角故事线`, color: 'success' })
  } catch (e) {
    toast.add({ title: '更新失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    applyingArcsTaskId.value = null
  }
}

/** 云端任务记录删除确认(安装成功后询问;选删除则删终态任务行) */
const deleteTaskOpen = ref(false)
const deleteTaskTitle = ref('')
const deleteTaskBody = ref('')
let deleteTaskResolve: ((remove: boolean) => void) | null = null

function askDeleteTaskModal(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    deleteTaskTitle.value = '删除云端任务记录'
    deleteTaskBody.value = `《${title}》已安装到书架,是否删除该云端任务记录?删除后本地书架不受影响,仅清掉这条云端任务记录。`
    deleteTaskResolve = resolve
    deleteTaskOpen.value = true
  })
}

function onDeleteTaskConfirm(remove: boolean) {
  deleteTaskOpen.value = false
  deleteTaskResolve?.(remove)
  deleteTaskResolve = null
}

async function cancelCloudTask(t: WorldGenTaskDTO) {
  try {
    await cancelWorldGenTask(t.id)
    await loadCloudTasks()
  } catch (e) {
    toast.add({ title: '操作失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 覆盖确认(通用 Promise 式弹窗):云端任务重装 / 同步云端覆盖 / 备份恢复共用 ----
const overwriteOpen = ref(false)
const overwriteTitle = ref('')
const overwriteBody = ref('')
let overwriteResolve: ((overwrite: boolean) => void) | null = null

function askOverwriteModal(title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    overwriteTitle.value = title
    overwriteBody.value = body
    overwriteResolve = resolve
    overwriteOpen.value = true
  })
}

/** 手动下载安装命中已安装作品:确认是否覆盖(不覆盖则保留现有,不重复添加) */
function askOverwriteCloudTask(existing: LocalWork): Promise<boolean> {
  return askOverwriteModal(
    '已安装过该任务',
    `本地已有《${existing.title}》,来源与本次下载为同一云端任务。是否用最新内容覆盖它?选择「保留现有」则跳过下载,不重复添加。`
  )
}

function onOverwriteConfirm(overwrite: boolean) {
  overwriteOpen.value = false
  overwriteResolve?.(overwrite)
  overwriteResolve = null
}

/** 继续暂停中的任务(充值后手动恢复;已完成单元自动复用,成功时才一次性结算) */
const resumingTaskId = ref<string | null>(null)

async function resumeCloudTask(t: WorldGenTaskDTO) {
  if (resumingTaskId.value) return
  resumingTaskId.value = t.id
  try {
    await resumeWorldGenTask(t.id)
    toast.add({ title: '任务已继续', description: '已从暂停处继续,成功完成后一次性结算', color: 'success' })
    await loadCloudTasks()
  } catch (e) {
    toast.add({ title: '继续失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    resumingTaskId.value = null
  }
}

/** 活动任务存在时每 3s 轮询;全部终态后停止 */
watch(hasActiveCloudTasks, (active) => {
  if (active && !cloudPollTimer) {
    cloudPollTimer = setInterval(() => {
      void loadCloudTasks()
    }, 3000)
  } else if (!active && cloudPollTimer) {
    clearInterval(cloudPollTimer)
    cloudPollTimer = null
  }
}, { immediate: true })

/** arcs 任务终态提示(completed/failed/paused 各一次;由 cloudTasks 轮询驱动,不重复轮询) */
watch(cloudTasks, (tasks) => {
  const id = pendingArcsTaskId.value
  if (!id) return
  const t = tasks.find(x => x.id === id)
  if (!t) return
  if (t.status === 'completed') {
    toast.add({ title: '配角故事线已生成', description: '在任务卡片点「更新世界情报」写回作品', color: 'success' })
    pendingArcsTaskId.value = null
  } else if (t.status === 'failed') {
    toast.add({ title: '配角故事线生成失败', description: t.error ?? undefined, color: 'error' })
    pendingArcsTaskId.value = null
  } else if (t.status === 'paused') {
    toast.add({ title: '任务待结算', description: '余额不足,充值后在云端任务区点「继续任务」完成结算,已生成的故事线保留', color: 'warning' })
    pendingArcsTaskId.value = null
  }
})

onUnmounted(() => {
  if (cloudPollTimer) clearInterval(cloudPollTimer)
})

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtChars(n?: number) {
  if (!n || n <= 0) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`
  if (n >= 1000) return `${(n / 1000).toFixed(1)} 千字`
  return `${n} 字`
}

function fmtBytes(n?: number | null) {
  if (!n || n <= 0) return '—'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

// ---- 继续游戏:作品卡片 → 模态框(按角色分组列出存档,每档可继续/删除)+ 新开游戏 ----
const continueOpen = ref(false)
const continueWorkTitle = ref('')
const continueWorkId = ref<string | null>(null)
const continueGames = ref<LocalGame[]>([])
/** 逐档删除确认的目标存档 id(confirmDeleteId 范式,null=未在确认) */
const deleteSaveId = ref<string | null>(null)

/** 该作品是否有本地游戏会话(有则作品卡片显示「继续游戏」按钮) */
function hasGamesFor(workId: string): boolean {
  return games.value.some(g => g.workId === workId)
}

function openContinue(w: LocalWork) {
  continueWorkTitle.value = w.title
  continueWorkId.value = w.id
  continueGames.value = games.value.filter(g => g.workId === w.id)
  continueOpen.value = true
}

/** 作品卡底部按钮(智能主按钮 + 阅读次按钮):
 *  有游戏进度→继续游戏;有角色卡→选择角色;云端恢复且无角色卡→生成世界;否则→阅读。
 *  主按钮不是阅读时补一个「阅读」软按钮保住读正文入口;云端恢复的无正文作品点击阅读只提示。 */
interface WorkCardAction {
  label: string
  icon: string
  color: 'primary' | 'neutral'
  variant: 'solid' | 'soft'
  to?: string
  onClick?: () => void
}

function workCardActions(w: LocalWork): WorkCardAction[] {
  const progress = progressFor('work', w.id)
  const readAction = (variant: 'solid' | 'soft'): WorkCardAction => isCloudRestored(w)
    ? {
        label: '阅读',
        icon: 'i-lucide-book-open',
        color: 'neutral',
        variant: 'soft',
        onClick: () => toast.add({ title: '云端恢复的作品暂无正文', description: '在「更多 → 补全正文」粘贴全文保存后即可阅读', color: 'warning' })
      }
    : { label: readBtnLabel(progress), icon: 'i-lucide-book-open', color: 'primary', variant, to: `/read/work/${w.id}` }
  if (hasGamesFor(w.id)) {
    return [
      { label: '继续游戏', icon: 'i-lucide-gamepad-2', color: 'primary', variant: 'solid', onClick: () => openContinue(w) },
      readAction('soft')
    ]
  }
  if ((w.overlay?.characters?.length ?? 0) > 0) {
    return [
      { label: '选择角色', icon: 'i-lucide-play', color: 'primary', variant: 'solid', onClick: () => selectRole(w) },
      readAction('soft')
    ]
  }
  if (isCloudRestored(w)) {
    return [{ label: '生成世界', icon: 'i-lucide-sparkles', color: 'primary', variant: 'solid', to: `/generate?from=work&id=${w.id}` }]
  }
  return [readAction('solid')]
}

/** 作品卡 meta 行:作者 · 全书字数 · 尺度 · 舞台(空项省略) */
/** 作品卡 meta 行:作者 · 全书字数 · 尺度(舞台单独成段,见模板 R2b) */
function workMetaLine(w: LocalWork): string {
  const parts = [`作者: ${w.author || '佚名'}`]
  parts.push(w.chapters.length ? `全书约 ${fmtChars(w.chapters.reduce((n, c) => n + c.content.length, 0))}` : '无正文')
  if (w.overlay?.heat) parts.push(`尺度:${w.overlay.heat}`)
  return parts.join(' · ')
}

/** 该作品有存档的角色分组(组内按最后游玩倒序的存档列表),供模态框选择/删除 */
const continueRoles = computed(() => {
  const byChar = new Map<string, LocalGame[]>()
  for (const g of continueGames.value) {
    const list = byChar.get(g.characterName) ?? []
    list.push(g)
    byChar.set(g.characterName, list)
  }
  return [...byChar.entries()]
    .map(([name, list]) => {
      const saves = list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return {
        name,
        count: list.length,
        lastAt: saves[0]?.updatedAt ?? '',
        saves
      }
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
})

function continueTo(g: LocalGame) {
  continueOpen.value = false
  navigateTo(`/games/${g.id}`)
}

/** 进度显示:优先段号;旧存档回退解析旧 currentChapter 字符串(如「第3段」),否则「—」 */
function saveProgress(g: LocalGame): string {
  if (typeof g.currentBeat === 'number' && g.currentBeat >= 0) return `第${g.currentBeat + 1}段`
  const legacy = (g as { currentChapter?: string | null }).currentChapter
  return legacy?.match(/^第\d+段/) ? legacy : '—'
}

const deleteSaveTarget = computed(() =>
  deleteSaveId.value ? continueGames.value.find(g => g.id === deleteSaveId.value) ?? null : null)

async function doDeleteSave() {
  const id = deleteSaveId.value
  const target = deleteSaveTarget.value
  deleteSaveId.value = null
  if (!id || !target) return
  try {
    await deleteGamePoints(id).catch(() => {})
    await deleteLocalGame(id)
    continueGames.value = continueGames.value.filter(g => g.id !== id)
    await refreshLocal()
    toast.add({ title: '已删除存档', description: `「${target.playerName}」的这局存档已移除`, color: 'success' })
  } catch (e) {
    toast.add({ title: '删除失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

/** 新开游戏:不动现有存档,直接回选角页另开一局(选角新建会话即新档,与旧档并存) */
function startNewGame() {
  const workId = continueWorkId.value
  continueOpen.value = false
  if (workId) navigateTo(`/play/${workId}`)
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

/** 上传 TXT 导入预览(自动识别编码 → UTF-8,确认后入库) */
interface ImportPreview {
  title: string
  encodingLabel: string
  preview: string
  truncated: boolean
  charCount: number
  chapters: ChapterSegment[]
}
const importPreview = ref<ImportPreview | null>(null)
/** 导入预览模态框开关(由预览内容驱动) */
const importPreviewOpen = computed({
  get: () => importPreview.value !== null,
  set: (v: boolean) => { if (!v) importPreview.value = null }
})

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  try {
    const parsed = await parseLocalNovel(file)
    const content = parsed.chapters[0]?.content ?? ''
    importPreview.value = {
      title: parsed.title,
      encodingLabel: NOVEL_ENCODING_LABELS[parsed.encoding as keyof typeof NOVEL_ENCODING_LABELS] ?? parsed.encoding,
      preview: content.slice(0, 400),
      truncated: content.length > 400,
      charCount: content.length,
      chapters: parsed.chapters
    }
  } catch (err) {
    toast.add({ title: '导入失败', description: err instanceof Error ? err.message : String(err), color: 'error' })
  } finally {
    importing.value = false
  }
}

/** 确认导入预览的作品(编码转换后的正文入库) */
async function confirmImportPreview() {
  const p = importPreview.value
  if (!p) return
  importing.value = true
  try {
    await saveImported(p.title, p.chapters)
    importPreview.value = null
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
    const chapters = toContentSegments(pasteText.value)
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
      <div class="flex items-center gap-2">
        <div
          v-if="cloudTasks.length > 0"
          class="relative me-2"
        >
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-cloud-cog"
            :loading="cloudTaskBusy"
            @click="openCloudTasks"
          >
            云端生成任务
          </UButton>
          <UBadge
            v-if="completedCloudTaskCount > 0"
            color="error"
            variant="solid"
            size="sm"
            class="pointer-events-none absolute -right-2 -top-2"
          >
            {{ completedCloudTaskCount > 99 ? '99+' : completedCloudTaskCount }}
          </UBadge>
        </div>
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
                class="h-full flex flex-col transition hover:border-primary-500/40 hover:shadow-md dark:hover:border-primary-500/30"
              >
                <p class="break-words font-semibold leading-snug">
                  {{ p.title }}
                </p>
                <p class="mt-1 truncate text-xs text-neutral-500">
                  {{ p.author || '佚名' }}
                </p>
                <div class="mt-2 flex flex-wrap gap-1">
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
                <div class="mt-auto flex flex-wrap gap-1.5 pt-3">
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

      <!-- 个人书架:云端生成任务 + 本地作品 + 云端作品(换设备恢复) -->
      <template #personal>
        <div class="mt-4">
          <!-- 云端生成任务详情(模态框:进行中进度条 / 完成可下载安装 / 暂停可继续) -->
          <UModal
            v-model:open="cloudTasksOpen"
            title="云端生成任务"
          >
            <template #body>
              <div class="space-y-2">
                <p
                  v-if="cloudTasks.length === 0"
                  class="py-4 text-center text-sm text-neutral-500"
                >
                  暂无云端生成任务
                </p>
              <UCard
                v-for="t in cloudTasks"
                :key="t.id"
                class="!py-3"
              >
                <!-- R1 状态行:图标 + 标题 + 阶段/消耗徽章(不再与按钮混排) -->
                <div class="flex min-w-0 items-center gap-2">
                  <UIcon
                    :name="t.status === 'completed'
                      ? 'i-lucide-circle-check'
                      : t.status === 'failed'
                        ? 'i-lucide-circle-x'
                        : t.status === 'cancelled'
                          ? 'i-lucide-circle-slash'
                          : t.status === 'paused'
                            ? 'i-lucide-pause-circle'
                            : 'i-lucide-loader-circle'"
                    class="size-4 shrink-0"
                    :class="t.status === 'completed'
                      ? 'text-green-500'
                      : t.status === 'failed'
                        ? 'text-red-500'
                        : t.status === 'cancelled'
                          ? 'text-neutral-400'
                          : t.status === 'paused'
                            ? 'text-amber-500'
                            : 'animate-spin text-primary-500'"
                  />
                  <p class="min-w-0 flex-1 truncate text-sm font-semibold">
                    {{ t.title || '未命名' }}
                  </p>
                  <UBadge
                    :color="t.status === 'completed' ? 'success' : t.status === 'failed' ? 'error' : t.status === 'cancelled' ? 'neutral' : t.status === 'paused' ? 'warning' : 'info'"
                    variant="soft"
                    size="sm"
                    class="shrink-0"
                  >
                    {{ worldGenStageLabel(t) }}
                  </UBadge>
                  <UBadge
                    v-if="t.tokensUsed && t.keySource !== 'user'"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-coins"
                    class="shrink-0"
                  >
                    {{ t.tokensUsed.toLocaleString() }} tokens
                  </UBadge>
                  <UBadge
                    v-if="t.keySource === 'user'"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    label="自建 Key"
                    class="shrink-0"
                  />
                </div>
                <p
                  v-if="t.status === 'failed' && t.error"
                  class="mt-1.5 break-all text-xs text-red-500"
                >
                  {{ t.error }}
                </p>
                <UProgress
                  v-if="t.status === 'running' || t.status === 'uploaded' || t.status === 'paused'"
                  :model-value="worldGenTaskPercent(t)"
                  size="xs"
                  class="mt-2"
                />
                <p
                  v-if="t.status === 'running' || t.status === 'uploaded'"
                  class="mt-1 text-xs text-neutral-500"
                >
                  {{ worldGenStageLabel(t) }} · {{ worldGenTaskPercent(t) }}% · 生成期间可离开页面
                </p>
                <p
                  v-else-if="t.status === 'paused' && t.stage === 'done'"
                  class="mt-1 text-xs text-amber-600 dark:text-amber-400"
                >
                  任务已完成但余额不足,结算前不可下载、不进入共享缓存;充值后点击「继续任务」完成结算
                </p>
                <p
                  v-else-if="t.status === 'paused'"
                  class="mt-1 text-xs text-amber-600 dark:text-amber-400"
                >
                  已在 {{ worldGenTaskPercent(t) }}% 处暂停;充值后点击「继续任务」从断点恢复,成功完成后一次性结算
                </p>
                <!-- R3 操作行(右对齐,与徽章分离不再乱换行) -->
                <div class="mt-2 flex justify-end gap-1.5">
                  <!-- arcs 任务完成:手动「更新世界情报」写回本地作品(已写回则显示已更新禁用) -->
                  <UButton
                    v-if="t.kind === 'arcs' && t.status === 'completed'"
                    :label="appliedArcsTaskIds[t.id] ? '已更新' : '更新世界情报'"
                    :icon="appliedArcsTaskIds[t.id] ? 'i-lucide-check' : 'i-lucide-refresh-cw'"
                    color="primary"
                    :variant="appliedArcsTaskIds[t.id] ? 'ghost' : 'soft'"
                    size="sm"
                    :loading="applyingArcsTaskId === t.id"
                    :disabled="!!appliedArcsTaskIds[t.id]"
                    @click="applyArcsResult(t)"
                  />
                  <!-- 整书任务完成:下载安装(已安装则显示已安装禁用) -->
                  <UButton
                    v-if="t.kind !== 'arcs' && t.status === 'completed'"
                    :label="taskInstalled(t) ? '已安装' : '下载安装'"
                    :icon="taskInstalled(t) ? 'i-lucide-check' : 'i-lucide-download'"
                    color="primary"
                    :variant="taskInstalled(t) ? 'ghost' : 'soft'"
                    size="sm"
                    :loading="installingTaskId === t.id"
                    :disabled="taskInstalled(t)"
                    @click="installCloudTask(t)"
                  />
                  <UButton
                    v-if="t.status === 'paused'"
                    label="继续任务"
                    icon="i-lucide-play"
                    color="primary"
                    variant="soft"
                    size="sm"
                    :loading="resumingTaskId === t.id"
                    @click="resumeCloudTask(t)"
                  />
                  <UButton
                    v-if="t.status === 'uploaded' || t.status === 'running' || t.status === 'paused'"
                    label="取消"
                    icon="i-lucide-circle-stop"
                    color="error"
                    variant="ghost"
                    size="sm"
                    @click="cancelCloudTask(t)"
                  />
                  <UButton
                    v-if="t.status !== 'running' && t.status !== 'uploaded'"
                    label="删除记录"
                    icon="i-lucide-trash-2"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    @click="cancelCloudTask(t)"
                  />
                </div>
              </UCard>
              </div>
            </template>
          </UModal>

          <!-- 本地作品 -->
          <div class="mb-6">
            <div class="mb-3 flex items-center justify-between">
              <h2 class="font-semibold">
                本地作品
              </h2>
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
                class="h-full flex flex-col transition hover:border-primary-500/40 hover:shadow-md dark:hover:border-primary-500/30"
              >
                <!-- R1 标题行 + 同步状态 -->
                <div class="flex items-start justify-between gap-2">
                  <p class="min-w-0 break-words font-semibold leading-snug">
                    {{ w.title }}
                  </p>
                  <span class="flex shrink-0 flex-wrap justify-end gap-1">
                    <UBadge
                      v-if="backupsLoaded && backupStale(w)"
                      color="warning"
                      variant="soft"
                      size="sm"
                    >
                      有更新待同步
                    </UBadge>
                    <UBadge
                      v-else-if="w.syncStatus === 'synced'"
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
                  </span>
                </div>

                <!-- R2 作者/字数/尺度(合并一行) -->
                <p class="mt-1.5 truncate text-xs text-neutral-500">
                  {{ workMetaLine(w) }}
                </p>

                <!-- R2b 舞台说明文(单独一段,最多两行) -->
                <p
                  v-if="w.overlay?.setting"
                  class="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-500"
                >
                  {{ w.overlay.setting }}
                </p>

                <!-- R3 状态徽章:云端恢复 + 阅读进度 + 补充故事线中 -->
                <div
                  v-if="isCloudRestored(w) || readBadges(progressFor('work', w.id)).length || activeArcsTask(w.id)"
                  class="mt-2 flex flex-wrap gap-1"
                >
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
                  <UBadge
                    v-if="activeArcsTask(w.id)"
                    color="info"
                    variant="soft"
                    size="sm"
                  >
                    <span class="flex items-center gap-1">
                      <UIcon
                        name="i-lucide-loader-circle"
                        class="size-3 animate-spin"
                      />
                      补充故事线中
                    </span>
                  </UBadge>
                </div>
                <!-- R4 性向/标签 + 世界详情徽章(可点进世界详情) -->
                <div
                  v-if="(w.overlay?.orientation && w.overlay.orientation !== '不明') || workCardTags(w).length || entityCount(w) || w.conflicts?.length || w.warnings?.length"
                  class="mt-2 flex flex-wrap gap-1"
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
                    v-if="entityCount(w)"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-globe"
                    class="cursor-pointer transition hover:opacity-70"
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
                    class="cursor-pointer transition hover:opacity-70"
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
                    class="cursor-pointer transition hover:opacity-70"
                    @click="openWorldDetail(w.id)"
                  >
                    告警 {{ w.warnings.length }}
                  </UBadge>
                </div>

                <!-- R5 底部信息:最后操作 / tokens 消耗各占一行(顶到卡片底部) -->
                <div class="mt-auto flex flex-col gap-1 pt-3">
                  <p class="min-w-0 truncate text-xs text-neutral-500">
                    最后操作: {{ fmtTime(w.updatedAt ?? w.createdAt) }}
                  </p>
                  <UBadge
                    v-if="w.tokensUsed"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-coins"
                    class="self-start"
                  >
                    已消耗 {{ w.tokensUsed.toLocaleString() }} tokens
                  </UBadge>
                </div>
                <!-- R6 操作区:智能主按钮(+ 阅读次按钮)+ 设置菜单 -->
                <div class="mt-2 flex items-center gap-1.5">
                  <UButton
                    v-for="a in workCardActions(w)"
                    :key="a.label"
                    :label="a.label"
                    :icon="a.icon"
                    :color="a.color"
                    :variant="a.variant"
                    size="sm"
                    :to="a.to"
                    @click="a.onClick?.()"
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

          <!-- 云端备份(每作品整包:作品+游戏会话+存盘点;与本地作品按 workId 对应) -->
          <div
            v-if="backupsLoaded"
            class="mb-6"
          >
            <h2 class="mb-3 font-semibold">
              云端备份
            </h2>
            <div
              v-if="backups.length === 0"
              class="text-sm text-neutral-500"
            >
              云端暂无备份。在本地作品卡片的「⋯」菜单里点「同步云端」,即可把作品、游戏会话与存盘点整包备份到云端,换设备可在此恢复。
            </div>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <UCard
                v-for="b in backups"
                :key="b.workId"
                class="h-full flex items-center justify-between gap-2 transition hover:border-primary-500/40 hover:shadow-md dark:hover:border-primary-500/30"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">
                    {{ b.title || '未命名作品' }}
                  </p>
                  <p class="truncate text-xs text-neutral-500">
                    {{ fmtTime(b.uploadedAt) }} · {{ b.gameCount ?? 0 }} 个游戏会话 · {{ fmtBytes(b.sizeBytes) }}
                  </p>
                </div>
                <div class="flex shrink-0 gap-1.5">
                  <UButton
                    label="下载到本机"
                    icon="i-lucide-download"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :loading="restoringBackupId === b.workId"
                    :disabled="!!restoringBackupId"
                    @click="restoreBackup(b)"
                  />
                  <UButton
                    icon="i-lucide-trash-2"
                    aria-label="删除备份"
                    color="error"
                    variant="ghost"
                    size="sm"
                    @click="askDeleteBackup(b)"
                  />
                </div>
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

    <!-- 上传 TXT 导入确认:自动识别编码转为 UTF-8,预览后确认入库 -->
    <UModal
      v-model:open="importPreviewOpen"
      title="导入确认"
      description="已自动识别编码并转换为 UTF-8,确认后加入本地书架"
    >
      <template #body>
        <div
          v-if="importPreview"
          class="space-y-3"
        >
          <div class="flex flex-wrap items-center gap-2">
            <p class="truncate text-sm font-semibold">
              《{{ importPreview.title }}》
            </p>
            <UBadge
              size="sm"
              color="info"
              variant="soft"
              icon="i-lucide-languages"
            >
              {{ importPreview.encodingLabel }} 已转换为 UTF-8
            </UBadge>
            <span class="text-xs text-neutral-400">
              共 {{ fmtChars(importPreview.charCount) }}
            </span>
          </div>
          <div class="rounded-lg border border-neutral-200 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/40">
            <p class="line-clamp-6 whitespace-pre-wrap text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
              {{ importPreview.preview }}
            </p>
            <p
              v-if="importPreview.truncated"
              class="mt-1 text-xs text-neutral-400"
            >
              …(预览截断)
            </p>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="取消"
            color="neutral"
            variant="outline"
            @click="importPreview = null"
          />
          <UButton
            label="确认导入"
            icon="i-lucide-upload"
            color="primary"
            :loading="importing"
            @click="confirmImportPreview"
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

    <!-- 覆盖确认(通用:云端任务重装 / 同步云端覆盖 / 备份恢复) -->
    <UModal
      v-model:open="overwriteOpen"
      :title="overwriteTitle"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          {{ overwriteBody }}
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="保留现有"
            color="neutral"
            variant="outline"
            @click="onOverwriteConfirm(false)"
          />
          <UButton
            label="覆盖"
            icon="i-lucide-refresh-cw"
            color="primary"
            @click="onOverwriteConfirm(true)"
          />
        </div>
      </template>
    </UModal>

    <!-- 安装完成后询问:是否删除云端任务记录 -->
    <UModal
      v-model:open="deleteTaskOpen"
      :title="deleteTaskTitle"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          {{ deleteTaskBody }}
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="保留记录"
            color="neutral"
            variant="outline"
            @click="onDeleteTaskConfirm(false)"
          />
          <UButton
            label="删除记录"
            icon="i-lucide-trash-2"
            color="error"
            @click="onDeleteTaskConfirm(true)"
          />
        </div>
      </template>
    </UModal>

    <!-- 导出游玩对话:选择会话(按角色分组,点击直接下载该会话旁白剧情 TXT) -->
    <UModal
      v-model:open="exportSessionOpen"
      :title="`导出游玩对话 · ${exportSessionWork?.title ?? ''}`"
    >
      <template #body>
        <div
          v-if="exportSessionGroups.length === 0"
          class="py-6 text-center text-sm text-neutral-500"
        >
          该作品还没有游戏会话,先开始一局游戏再导出
        </div>
        <div
          v-else
          class="flex max-h-[60vh] flex-col gap-4 overflow-y-auto"
        >
          <div
            v-for="grp in exportSessionGroups"
            :key="grp.name"
          >
            <p class="mb-1.5 text-xs font-semibold text-neutral-500">
              {{ grp.name }}
            </p>
            <div class="flex flex-col gap-1.5">
              <button
                v-for="g in grp.list"
                :key="g.id"
                type="button"
                class="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm transition hover:border-primary-400 dark:border-neutral-700"
                :title="`导出「${grp.name}」的游玩对话 TXT`"
                @click="exportSessionTxt(g)"
              >
                <span class="shrink-0 text-xs tabular-nums text-neutral-500">
                  {{ turnsOf(g) }} 回合
                </span>
                <span class="min-w-0 flex-1 truncate text-right text-xs text-neutral-500">
                  {{ fmtTime(g.updatedAt) }}
                </span>
                <UIcon
                  name="i-lucide-download"
                  class="size-4 shrink-0 text-neutral-400"
                />
              </button>
            </div>
          </div>
        </div>
        <p class="mt-3 text-xs text-neutral-400">
          点击某条会话直接下载该会话的旁白剧情 TXT(自动剔除玩家行动与选项)
        </p>
      </template>
    </UModal>

    <!-- 删除云端备份确认 -->
    <UModal
      v-model:open="backupDeleteOpen"
      title="删除云端备份"
      description="此操作不可撤销"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          确定删除《{{ backupDeleteTarget?.title || '未命名作品' }}》的云端备份?本地数据不受影响,删除后需重新「同步云端」才能恢复该备份。
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="取消"
            color="neutral"
            variant="outline"
            @click="backupDeleteOpen = false"
          />
          <UButton
            label="删除"
            icon="i-lucide-trash-2"
            color="error"
            @click="confirmDeleteBackup"
          />
        </div>
      </template>
    </UModal>

    <!-- 旧版分章格式作品:开始新游戏前建议重新生成世界 -->
    <UModal
      v-model:open="legacyStartOpen"
      title="建议重新生成世界"
      description="该作品为旧版分章格式"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          《{{ legacyStartWork?.title }}》按旧版章节切分存储,章节识别可能不准,会影响细纲定位与开局体验。建议重新生成世界后再开始;也可以照常游玩。
        </p>
        <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
          重新生成会保留已有产物并补齐内容;若想得到最完整的识别结果,推荐<strong>重新上传原始 txt 再生成</strong>,效果更佳。
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="仍然继续"
            color="neutral"
            variant="outline"
            @click="legacyStartProceed"
          />
          <UButton
            label="重新生成世界"
            icon="i-lucide-refresh-cw"
            color="primary"
            @click="legacyStartRegenerate"
          />
        </div>
      </template>
    </UModal>

    <!-- 继续游戏:按角色分组列出存档(每档可继续/删除),顶部可新开游戏 -->
    <UModal
      :open="continueOpen"
      @update:open="continueOpen = $event"
    >
      <template #title>
        <span class="flex items-center gap-2">
          <UIcon
            name="i-lucide-gamepad-2"
            class="size-4 text-primary"
          />
          继续游戏
        </span>
      </template>
      <template #body>
        <p class="text-xs text-neutral-500">
          《{{ continueWorkTitle }}》 · 选择要续玩的存档
        </p>
        <!-- 新开游戏:不动现有存档,回选角页另开一局 -->
        <div class="mt-3 flex items-center justify-between gap-2 rounded-xl border border-dashed border-primary-300 bg-primary-500/5 px-3 py-2.5 dark:border-primary-700">
          <div class="min-w-0">
            <p class="text-sm font-semibold">
              新开游戏
            </p>
            <p class="text-xs text-neutral-500">
              另开一局新游戏,现有存档全部保留
            </p>
          </div>
          <UButton
            label="新开游戏"
            icon="i-lucide-plus"
            color="primary"
            variant="soft"
            size="sm"
            @click="startNewGame"
          />
        </div>
        <div
          v-if="continueRoles.length"
          class="mt-3 flex flex-col gap-3"
        >
          <div
            v-for="role in continueRoles"
            :key="role.name"
            class="flex flex-col gap-2"
          >
            <p class="text-xs font-medium text-neutral-500">
              {{ role.name }} · {{ role.count }} 局存档
            </p>
            <div
              v-for="g in role.saves"
              :key="g.id"
              class="flex items-center justify-between gap-2 rounded-xl border border-neutral-200 px-3 py-2.5 dark:border-neutral-700"
            >
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold">
                  你是「{{ g.playerName }}」
                </p>
                <p class="text-xs text-neutral-500">
                  {{ saveProgress(g) }} · {{ g.messages.length }} 条剧情 · 最后 {{ fmtTime(g.updatedAt) }}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <UButton
                  label="继续"
                  icon="i-lucide-play"
                  color="primary"
                  size="sm"
                  @click="continueTo(g)"
                />
                <UButton
                  label="删除"
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="outline"
                  size="sm"
                  @click="deleteSaveId = g.id"
                />
              </div>
            </div>
          </div>
        </div>
        <p
          v-else
          class="mt-3 text-center text-sm text-neutral-400"
        >
          该作品暂无存档,可新开游戏
        </p>
      </template>
    </UModal>

    <!-- 删除单档确认 -->
    <UModal
      :open="deleteSaveId !== null"
      @update:open="deleteSaveId = null"
    >
      <template #title>
        删除存档
      </template>
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          确定删除《{{ continueWorkTitle }}》中「{{ deleteSaveTarget?.playerName }}」的这局存档?
          删除后不可恢复。
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="取消"
            color="neutral"
            variant="outline"
            @click="deleteSaveId = null"
          />
          <UButton
            label="删除"
            icon="i-lucide-trash-2"
            color="error"
            @click="doDeleteSave"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
