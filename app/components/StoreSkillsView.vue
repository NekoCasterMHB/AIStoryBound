<script setup lang="ts">
import { useAuthSession } from '~/utils/auth-client'
import { useAuthModal } from '~/composables/useAuthModal'
import { getUserSkills, installStoreSkillZip } from '~/utils/aiSkills'
import { parseMarkdown } from '@nuxtjs/mdc/runtime'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { SKILL_STATUS_LABELS } from '#shared/store-skill'
import type { MyPublishedSkill, MyPurchasedSkill, SkillStatus, SkillVersionBrief, StoreSkillSummary } from '#shared/store-skill'

type MarkdownBody = Awaited<ReturnType<typeof parseMarkdown>>['body']

// Skill 商城面板(创意工坊「Skill包」tab;游客可浏览;购买/我的需登录)。

const { data: session } = await useAuthSession()
const user = computed(() => session.value?.user)
const { requireLogin } = useAuthModal()
const toast = useToast()

/** 「我的发布」表格状态徽章颜色 */
const STATUS_BADGE_COLORS: Record<SkillStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
  removed: 'neutral'
}

// ---- 数据 ----
const skills = ref<StoreSkillSummary[]>([])
// 初始即 true:避免首帧渲染出"商城还没有商品"空状态(onMounted 前 loading 为 false)
const loading = ref(true)
const mineLoading = ref(true)
const mine = ref<{ purchased: import('#shared/store-skill').MyPurchasedSkill[], published: import('#shared/store-skill').MyPublishedSkill[] }>({ purchased: [], published: [] })

async function loadSkills() {
  loading.value = true
  try {
    skills.value = await $fetch<StoreSkillSummary[]>('/api/store/skills')
  } catch (e) {
    toast.add({ title: '加载商城失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
async function loadMine() {
  mineLoading.value = true
  try {
    mine.value = await $fetch('/api/store/mine')
  } catch (e) {
    toast.add({ title: '加载我的数据失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    mineLoading.value = false
  }
}
onMounted(() => {
  void loadSkills()
  void loadDownloaded()
  if (user.value) void loadMine()
})

function fmtTokens(n: number) {
  return n.toLocaleString('zh-CN')
}
function fmtTs(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}
function fmtDay(ts: number) {
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 卡片说明 = README 正文的第一段纯文本:跳过标题/引用/列表/表格/分隔线等结构段,
 *  以及入库时已脱去 # 的短标题行(如「类定义」),取第一个真正的正文段;
 *  再剥离段内行首符号与内联 markdown 符号(加粗、行内代码、链接等),返回不含符号的纯正文。 */
function firstParagraph(md: string) {
  const blocks = md.split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l.length)
    if (!lines.length) continue
    // 整段都是结构符号(标题/引用/列表/有序列表/勾选列表/表格/分隔线/代码围栏)→ 跳过
    const allStructural = lines.every(l =>
      /^(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|```|~~~|\[[ x]\])\s*/.test(l)
      || /^\|/.test(l)
      || /^[-*_]{3,}$/.test(l))
    if (allStructural) continue
    // 无句读的短标题行(单行、较短、不以句号/感叹号/问号结尾)→ 跳过
    if (lines.length === 1 && (lines[0] ?? '').length <= 30 && !/[。！？.!?]$/.test(lines[0] ?? '')) continue
    // 去掉段内行首的标题/引用/列表符号,剥离内联 markdown 符号,拼成纯文本
    return lines
      .map(l => l.replace(/^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, ''))
      .join(' ')
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
}

// ---- Tab ----
const tab = ref('all')

async function onTabChange(v: string | number) {
  const key = String(v)
  if (key !== 'all' && !user.value) {
    const ok = await requireLogin()
    if (!ok) {
      tab.value = 'all'
      return
    }
  }
  tab.value = key
  if (key === 'bought' || key === 'published') {
    await loadMine()
  }
}

// ---- 购买 ----
const buyTarget = ref<StoreSkillSummary | null>(null)
const buyOpen = ref(false)
const buying = ref(false)
/** 购买模态框阶段:confirm=确认购买 / fetch=购买完成,引导立即获取技能 */
const buyStage = ref<'confirm' | 'fetch'>('confirm')
/** 确认框展示的当前余额(收费技能打开时从 /api/profile/me 拉取,供显示支付后余额) */
const buyBalance = ref<number | null>(null)
const buyBalanceLoading = ref(false)
/** 余额已知且不足以支付时,确认按钮禁用并提示充值 */
const buyInsufficient = computed(() => {
  const t = buyTarget.value
  const b = buyBalance.value
  return !!t && t.price > 0 && b !== null && b < t.price
})

async function onBuy(skill: StoreSkillSummary) {
  const ok = await requireLogin()
  if (!ok) return
  buyTarget.value = skill
  buyStage.value = 'confirm'
  buyOpen.value = true
  buyBalance.value = null
  if (skill.price > 0) {
    buyBalanceLoading.value = true
    try {
      const me = await $fetch<{ aiTokenBalance?: number }>('/api/profile/me')
      buyBalance.value = me?.aiTokenBalance ?? null
    } catch {
      buyBalance.value = null
    } finally {
      buyBalanceLoading.value = false
    }
  }
}

async function confirmBuy() {
  const target = buyTarget.value
  if (!target) return
  buying.value = true
  try {
    const res = await $fetch<{ ok: true, price: number }>(`/api/store/skills/${target.id}/purchase`, { method: 'POST' })
    toast.add({
      title: res.price > 0 ? `购买成功,已扣除 ${fmtTokens(res.price)} tokens` : '已免费获取,永久可下载',
      description: res.price > 0 ? '购买后永久可下载;发布者将获得其中的 80%' : '免费 Skill 在商城拥有更高展示优先级',
      color: 'success'
    })
    // 购买完成 → 切换为"获取技能"阶段,引导立即安装到本地
    buyStage.value = 'fetch'
    await loadSkills()
    if (user.value) await loadMine()
  } catch (e) {
    toast.add({ title: '购买失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    buying.value = false
  }
}

/** 模态框「获取技能」:安装后关闭模态框,卡片随即显示「已获取」 */
async function modalFetch() {
  const target = buyTarget.value
  if (!target) return
  await onFetch(target.id, defaultSkillVersion(target), target.name)
  buyOpen.value = false
  buyStage.value = 'confirm'
  buyTarget.value = null
}

function downloadUrl(id: string, version?: number) {
  return `/api/store/skills/${id}/download${version ? `?version=${version}` : ''}`
}

// ---- 下载 = 安装:拉取 zip → 校验并注册本地(自动启用)→ 另存 zip 文件 ----
const installingId = ref('')

function isInstalling(id: string, version?: number) {
  return installingId.value === `${id}:${version ?? 'default'}`
}

/** 触发浏览器保存 zip 文件(备份/分享用;安装本身已在本机完成) */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function onDownload(id: string, name: string, version?: number) {
  if (installingId.value) return
  installingId.value = `${id}:${version ?? 'default'}`
  try {
    const blob = await $fetch<Blob>(downloadUrl(id, version), { responseType: 'blob' })
    const zip = new Uint8Array(await blob.arrayBuffer())
    const skill = await installStoreSkillZip(zip, id, version, name)
    if (typeof version === 'number') {
      downloadedVersions.value[id] = version
    }
    const clean = skill.name.replace(/[\\/:*?"<>|]/g, '_') || 'skill'
    saveBlob(blob, `${clean}${version ? `-v${version}` : ''}.zip`)
    toast.add({
      title: '已下载并启用',
      description: `「${skill.name}」已加入技能管理(个人中心)并自动启用,游玩时 AI 将按此 SOP 展开专业玩法`,
      color: 'success'
    })
  } catch (e) {
    toast.add({
      title: '下载安装失败',
      description: e instanceof Error ? e.message : String(e),
      color: 'error'
    })
  } finally {
    installingId.value = ''
  }
}

/** 卡片上当前选中的获取版本(默认主版本,未设置主版本时取最新已上架版本) */
function defaultSkillVersion(s: StoreSkillSummary): number | undefined {
  return verSel[s.id] ?? cardMainVersion(s) ?? undefined
}

/** 卡片「当前主版本」:发布者手动指定优先,否则最新已上架版本(versions[0]) */
function cardMainVersion(s: StoreSkillSummary): number | null {
  if (typeof s.mainVersion === 'number' && s.versions.some(v => v.version === s.mainVersion)) return s.mainVersion
  return s.versions[0]?.version ?? null
}

/** 卡片「获取技能」按钮文案:选中的是主版本时不带版本号;其余版本带版本号 */
function fetchLabel(s: StoreSkillSummary): string {
  const ver = defaultSkillVersion(s)
  if (typeof ver !== 'number') return '获取技能'
  return ver === cardMainVersion(s) ? '获取技能' : `获取技能 v${ver}`
}

/** 卡片「获取技能」的版本菜单:开头「获取特定版本」标题,每个版本独立分组(组间分割线),当前选中项打勾,主版本带「主版本」标记 */
function cardVersionItems(s: StoreSkillSummary) {
  const main = cardMainVersion(s)
  return [
    [{ type: 'label' as const, label: '获取特定版本' }],
    ...s.versions.map(v => [{
      label: `v${v.version} · 发布日期:${fmtDay(v.createdAt)}`,
      icon: v.version === defaultSkillVersion(s) ? 'i-lucide-check' : 'i-lucide-download',
      kbds: v.version === main ? ['主版本'] : undefined,
      onSelect: () => { verSel[s.id] = v.version }
    }])
  ]
}

/** 已本地安装(IndexedDB,含未启用)的商城技能 id,用于卡片「已获取」判定 */
const downloadedIds = ref<Set<string>>(new Set())
function isDownloaded(id: string) {
  return downloadedIds.value.has(id)
}

/** 本地已装版本号(key=商城商品 id;无商城来源记录时为 undefined) */
const downloadedVersions = ref<Record<string, number>>({})

/** 本地版本是否落后于卡片默认获取的版本(默认=主版本;本地无版本号视为未知,不提示更新) */
function hasStoreUpdate(s: StoreSkillSummary): boolean {
  const local = downloadedVersions.value[s.id]
  if (typeof local !== 'number') return false
  const target = defaultSkillVersion(s)
  return typeof target === 'number' && local < target
}

async function loadDownloaded() {
  try {
    const skills = await getUserSkills()
    downloadedIds.value = new Set(skills.map(s => s.key))
    downloadedVersions.value = {}
    for (const s of skills) {
      if (typeof s.storeVersion === 'number') downloadedVersions.value[s.key] = s.storeVersion
    }
  } catch {
    downloadedIds.value = new Set()
    downloadedVersions.value = {}
  }
}

/** 获取技能:拉取指定版本 zip → 校验并注册本地(IndexedDB,自动启用),不生成下载文件 */
async function onFetch(id: string, version: number | undefined, name?: string) {
  if (installingId.value) return
  installingId.value = `${id}:${version ?? 'default'}`
  try {
    const blob = await $fetch<Blob>(downloadUrl(id, version), { responseType: 'blob' })
    const zip = new Uint8Array(await blob.arrayBuffer())
    const skill = await installStoreSkillZip(zip, id, version, name)
    downloadedIds.value.add(id)
    if (typeof version === 'number') {
      downloadedVersions.value[id] = version
    }
    toast.add({
      title: '已获取并启用',
      description: `「${skill.name}」已加入技能管理(个人中心)并自动启用,游玩时 AI 将按此 SOP 展开专业玩法`,
      color: 'success'
    })
  } catch (e) {
    toast.add({
      title: '获取技能失败',
      description: e instanceof Error ? e.message : String(e),
      color: 'error'
    })
  } finally {
    installingId.value = ''
  }
}

/** 我的发布里最新提交的版本(行状态以最新版本为准) */
function latestVersionOf(p: MyPublishedSkill) {
  return p.versions[0] ?? null
}

/** 行状态:下架/整体待审以主表为准;在售商品展示最新提交版本的审核状态 */
function rowStatusOf(p: MyPublishedSkill): SkillStatus {
  if (p.status !== 'approved') return p.status
  return latestVersionOf(p)?.status ?? p.status
}

/** 「我的发布」表格列:名称 / 状态 / 售价 / 下载次数 / 最后更新 / 版本管理 / 操作 */
const publishedColumns: TableColumn<MyPublishedSkill>[] = [
  { id: 'name', header: '名称' },
  { id: 'status', header: '状态' },
  {
    id: 'price',
    header: '售价',
    meta: { class: { td: 'whitespace-nowrap' } }
  },
  {
    id: 'downloadCount',
    header: '下载次数',
    meta: { class: { td: 'whitespace-nowrap tabular-nums' } }
  },
  {
    id: 'updatedAt',
    header: '最后更新',
    meta: { class: { td: 'whitespace-nowrap' } }
  },
  { id: 'versions', header: '版本' },
  {
    id: 'actions',
    header: '操作',
    meta: { class: { th: 'text-right', td: 'text-right whitespace-nowrap' } }
  }
]

/** 「版本管理」弹窗表格列:版本号 / 审核状态 / 提交时间 / 操作 */
const versionColumns: TableColumn<SkillVersionBrief>[] = [
  {
    id: 'version',
    header: '版本号',
    meta: { class: { td: 'whitespace-nowrap' } }
  },
  { id: 'status', header: '审核状态' },
  {
    id: 'createdAt',
    header: '提交时间',
    meta: { class: { td: 'whitespace-nowrap' } }
  },
  {
    id: 'actions',
    header: '操作',
    meta: { class: { th: 'text-right', td: 'text-right whitespace-nowrap' } }
  }
]

/** 每行选中的下载版本(默认购买版/最新提交版),key=skill id;选中后下载按钮文案随之切换 */
const verSel = reactive<Record<string, number>>({})

/** 「我的购买」版本菜单:购买锁定版(标注购买版)+ 后续已上架版本(发布时间) */
function boughtVersionItems(p: MyPurchasedSkill) {
  const seen = new Set<number>()
  const items: { label: string, icon: string, onSelect: () => void }[] = []
  if (!seen.has(p.purchasedVersion)) {
    seen.add(p.purchasedVersion)
    items.push({
      label: `v${p.purchasedVersion} · 我的购买版 · ${fmtDay(p.purchasedAt)}`,
      icon: 'i-lucide-bookmark',
      onSelect: () => { verSel[p.id] = p.purchasedVersion }
    })
  }
  for (const v of [...p.versions].sort((a, b) => b.version - a.version)) {
    if (seen.has(v.version)) continue
    seen.add(v.version)
    items.push({
      label: `v${v.version} · ${fmtDay(v.createdAt)}`,
      icon: 'i-lucide-download',
      onSelect: () => { verSel[p.id] = v.version }
    })
  }
  return items
}

/** 「我的发布」操作菜单:更新版本(绿)/ 下架(红)/ 重新上架 */
function publishActionsItems(p: MyPublishedSkill) {
  const items: DropdownMenuItem[] = [
    { label: '更新版本', icon: 'i-lucide-upload', color: 'success', onSelect: () => navigateTo(`/store/publish?skill=${p.id}`) }
  ]
  if (p.status === 'approved') {
    items.push({ label: '下架', icon: 'i-lucide-arrow-down-circle', color: 'error', onSelect: () => onUnlist(p) })
  } else if (p.status === 'removed') {
    items.push({ label: '重新上架', icon: 'i-lucide-arrow-up-circle', onSelect: () => onRelist(p) })
  }
  return items
}

// ---- 版本管理:查看全部版本,切换商城展示的主版本 ----
const versionsOpen = ref(false)
const versionsTarget = ref<MyPublishedSkill | null>(null)
const setMainBusy = ref('')

function openVersions(p: MyPublishedSkill) {
  versionsTarget.value = p
  versionsOpen.value = true
}

/** 当前主版本:手动设置者优先,否则最新已上架版本 */
function mainVersionOf(p: MyPublishedSkill): number | null {
  if (p.mainVersion) return p.mainVersion
  return p.versions.find(v => v.status === 'approved')?.version ?? null
}

async function onSetMainVersion(p: MyPublishedSkill, version: number) {
  setMainBusy.value = `${p.id}:${version}`
  try {
    await $fetch(`/api/store/skills/${p.id}/version`, { method: 'POST', body: { version, main: true } })
    toast.add({
      title: '已切换主版本',
      description: `商城将以 v${version} 的名称/说明/价格展示`,
      color: 'success'
    })
    await loadMine()
    versionsTarget.value = mine.value.published.find(x => x.id === p.id) ?? versionsTarget.value
  } catch (e) {
    toast.add({
      title: '切换主版本失败',
      description: e instanceof Error ? e.message : String(e),
      color: 'error'
    })
  } finally {
    setMainBusy.value = ''
  }
}

/** 启用/禁用版本:禁用的版本用户侧不显示,已购者仍可下载购买锁定的版本 */
const setVersionBusy = ref('')

async function onToggleVersionEnabled(p: MyPublishedSkill, version: number, enabled: boolean) {
  const key = `${p.id}:${version}`
  setVersionBusy.value = key
  try {
    await $fetch(`/api/store/skills/${p.id}/version`, { method: 'POST', body: { version, enabled } })
    toast.add({
      title: enabled ? `已启用 v${version}` : `已禁用 v${version}`,
      description: enabled
        ? '该版本已恢复在用户侧(商城/已购)显示'
        : '该版本已从用户侧隐藏,已购者仍可下载购买锁定的版本',
      color: 'success'
    })
    await loadMine()
    versionsTarget.value = mine.value.published.find(x => x.id === p.id) ?? versionsTarget.value
  } catch (e) {
    toast.add({
      title: enabled ? '启用版本失败' : '禁用版本失败',
      description: e instanceof Error ? e.message : String(e),
      color: 'error'
    })
  } finally {
    setVersionBusy.value = ''
  }
}

// ---- 下架 / 重新上架(下架后从商城隐藏;重新上架需管理员再次审核) ----
const statusTarget = ref<MyPublishedSkill | null>(null)
const statusAction = ref<'unlist' | 'relist'>('unlist')
const statusOpen = ref(false)
const statusBusy = ref(false)

function onUnlist(p: MyPublishedSkill) {
  statusTarget.value = p
  statusAction.value = 'unlist'
  statusOpen.value = true
}

function onRelist(p: MyPublishedSkill) {
  statusTarget.value = p
  statusAction.value = 'relist'
  statusOpen.value = true
}

async function confirmStatus() {
  const target = statusTarget.value
  if (!target) return
  statusBusy.value = true
  try {
    await $fetch(`/api/store/skills/${target.id}/status`, {
      method: 'POST',
      body: { status: statusAction.value === 'unlist' ? 'removed' : 'pending' }
    })
    statusOpen.value = false
    toast.add({
      title: statusAction.value === 'unlist' ? '已下架' : '已提交重新上架',
      description: statusAction.value === 'unlist'
        ? '商品已从商城下架,已购买用户仍可下载;可随时重新上架(需再次审核)'
        : '已进入待审核,管理员审核通过后恢复在商城展示',
      color: 'success'
    })
    await loadMine()
  } catch (e) {
    toast.add({
      title: statusAction.value === 'unlist' ? '下架失败' : '重新上架失败',
      description: e instanceof Error ? e.message : String(e),
      color: 'error'
    })
  } finally {
    statusBusy.value = false
  }
}

// ---- 预览(商城卡片):未付费仅可看 README 摘要;免费/已购买可看全部 markdown ----
interface PreviewData {
  name: string
  price: number
  canViewAll: boolean
  /** 未付费可读的 README 摘要 */
  readme: string
  /** 文件清单(仅 canViewAll 时返回;未付费为空,只给 entryCount) */
  entries: { name: string, size: number, isDirectory: boolean }[]
  /** 压缩包内文件总数 */
  entryCount?: number
  files: { name: string, content: string }[]
}
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const previewData = ref<PreviewData | null>(null)
const previewIdx = ref(0)
const previewAst = ref<MarkdownBody | null>(null)

async function onPreview(s: StoreSkillSummary) {
  previewOpen.value = true
  previewLoading.value = true
  previewError.value = ''
  previewData.value = null
  previewAst.value = null
  try {
    previewData.value = await $fetch<PreviewData>(`/api/store/skills/${s.id}/preview`)
    previewIdx.value = 0
    await onPreviewFile(0)
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

async function onPreviewFile(i: number) {
  previewIdx.value = i
  previewAst.value = null
  previewError.value = ''
  const content = previewData.value?.files[i]?.content ?? ''
  if (!content) return
  try {
    const { body } = await parseMarkdown(content)
    previewAst.value = body
  } catch {
    previewError.value = 'Markdown 解析失败'
  }
}
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="flex items-center gap-2 text-xl font-semibold">
          <UIcon
            name="i-lucide-store"
            class="size-5 text-primary"
          />
          Skill 商城
        </h1>
        <p class="mt-1 text-sm text-neutral-500">
          用 token 选购 agent skill 玩法,下载即自动安装并启用;游玩时 AI 按技能 SOP 展开专业玩法,也可调教出符合 xp 的专属人格。发布自己的 skill 还能赚取 token
        </p>
      </div>
      <UButton
        to="/store/publish"
        color="primary"
        icon="i-lucide-upload"
      >
        发布 Skill
      </UButton>
    </div>

    <UTabs
      :model-value="tab"
      variant="link"
      :items="[
        { label: '全部', value: 'all', slot: 'all' },
        { label: '我的购买', value: 'bought', slot: 'bought' },
        { label: '我的发布', value: 'published', slot: 'published' }
      ]"
      class="mb-6"
      @update:model-value="onTabChange"
    >
      <!-- 全部:商品卡片 -->
      <template #all>
        <div
          v-if="loading"
          class="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          加载中…
        </div>
        <div
          v-else-if="!skills.length"
          class="py-10 text-center text-sm text-neutral-500"
        >
          商城还没有商品,成为第一个发布者吧
        </div>
        <div
          v-else
          class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <UCard
            v-for="s in skills"
            :key="s.id"
            class="flex flex-col"
            :ui="{ body: 'flex-1' }"
          >
            <!-- 第一行:方形圆角图标 + 标题 + 标题下方标签 -->
            <div class="flex items-start gap-3">
              <div
                class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10"
              >
                <span
                  v-if="s.icon"
                  class="text-2xl leading-none"
                >{{ s.icon }}</span>
                <img
                  v-else
                  src="/icons/default-skill-icon.png"
                  alt=""
                  class="h-full w-full object-cover"
                >
              </div>
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 font-semibold">
                  <span class="min-w-0 truncate">{{ s.name }}</span>
                  <UBadge
                    v-if="s.versions.length"
                    size="sm"
                    variant="subtle"
                    class="shrink-0"
                  >
                    v{{ cardMainVersion(s) }}
                  </UBadge>
                  <UBadge
                    v-if="s.featured === 1"
                    size="md"
                    color="warning"
                    variant="soft"
                    icon="i-lucide-star"
                    leading
                    class="shrink-0"
                  >
                    优质推荐
                  </UBadge>
                </p>
                <div
                  v-if="s.tags.length"
                  class="mt-1 flex flex-wrap items-center gap-1.5"
                >
                  <UBadge
                    v-for="t in s.tags"
                    :key="t"
                    size="md"
                    color="neutral"
                    variant="outline"
                  >
                    {{ t }}
                  </UBadge>
                </div>
              </div>
            </div>
            <!-- 第二行:说明文 = README 内容第一段,最多 3 行省略 -->
            <p class="mt-3 line-clamp-3 min-h-17 text-sm leading-relaxed text-neutral-500">
              {{ firstParagraph(s.readme) || s.desc || '暂无说明' }}
            </p>
            <div class="mt-2 flex items-center justify-between text-xs">
              <div class="flex items-center gap-3">
                <span
                  class="flex items-center gap-1 tabular-nums text-neutral-500"
                  :title="`下载 ${s.downloadCount}`"
                >
                  <UIcon
                    name="i-lucide-download"
                    class="size-3.5"
                  />
                  {{ s.downloadCount }}
                </span>
                <UBadge
                  v-if="s.purchased"
                  color="primary"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-circle-check"
                  leading
                >
                  已购买
                </UBadge>
                <UBadge
                  v-else-if="s.price > 0"
                  color="warning"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-coins"
                  leading
                  class="tabular-nums"
                >
                  {{ fmtTokens(s.price) }} tokens
                </UBadge>
                <UBadge
                  v-else
                  color="success"
                  variant="soft"
                  size="sm"
                >
                  免费
                </UBadge>
              </div>
              <p class="flex min-w-0 items-center gap-1 text-neutral-400">
                <UIcon
                  name="i-lucide-user-round"
                  class="size-3.5 shrink-0"
                />
                <span class="truncate">{{ s.sellerName }}</span>
              </p>
            </div>
            <!-- Footer:预览(左)与获取/购买(右)分区,互不混排 -->
            <template #footer>
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <UButton
                    size="md"
                    variant="outline"
                    color="neutral"
                    icon="i-lucide-book-open"
                    aria-label="预览内容"
                    @click="onPreview(s)"
                  >
                    预览
                  </UButton>
                </div>
                <UFieldGroup
                  v-if="s.owned && !isDownloaded(s.id)"
                  class="flex-1"
                >
                  <UButton
                    block
                    color="primary"
                    size="md"
                    icon="i-lucide-download"
                    :loading="isInstalling(s.id, defaultSkillVersion(s))"
                    class="flex-1"
                    @click="onFetch(s.id, defaultSkillVersion(s), s.name)"
                  >
                    {{ fetchLabel(s) }}
                  </UButton>
                  <UDropdownMenu
                    v-if="s.versions.length"
                    :items="cardVersionItems(s)"
                    :ui="{ item: 'text-xs' }"
                  >
                    <UButton
                      color="primary"
                      size="md"
                      icon="i-lucide-chevron-down"
                      aria-label="选择获取版本"
                      class="border-l border-white/30"
                    />
                  </UDropdownMenu>
                </UFieldGroup>
                <UButton
                  v-else-if="s.owned && hasStoreUpdate(s)"
                  color="success"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-refresh-cw"
                  :loading="isInstalling(s.id, defaultSkillVersion(s))"
                  @click="onFetch(s.id, defaultSkillVersion(s), s.name)"
                >
                  更新版本
                </UButton>
                <UButton
                  v-else-if="s.owned"
                  to="/profile?tab=skills"
                  color="success"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-circle-check"
                >
                  已获取
                </UButton>
                <UButton
                  v-else
                  color="primary"
                  size="sm"
                  :icon="s.price > 0 ? 'i-lucide-shopping-cart' : 'i-lucide-gift'"
                  @click="onBuy(s)"
                >
                  {{ s.price > 0 ? '支付并获取' : '免费获取' }}
                </UButton>
              </div>
            </template>
          </UCard>
        </div>
      </template>

      <!-- 我的购买 -->
      <template #bought>
        <div
          v-if="!user"
          class="py-10 text-center text-sm text-neutral-500"
        >
          登录后查看已购买的 Skill
        </div>
        <div
          v-else-if="mineLoading"
          class="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          加载中…
        </div>
        <UCard v-else-if="!mine.purchased.length">
          <p class="py-6 text-center text-sm text-neutral-500">
            还没有购买记录,去「全部」挑一个吧
          </p>
        </UCard>
        <ul
          v-else
          class="space-y-3"
        >
          <li
            v-for="p in mine.purchased"
            :key="p.id"
          >
            <UCard class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="flex items-center gap-2 truncate font-medium">
                  {{ p.name }}
                  <UBadge
                    v-if="p.featured === 1"
                    color="primary"
                    size="sm"
                  >
                    推荐
                  </UBadge>
                </p>
                <p class="mt-0.5 text-xs text-neutral-500">
                  {{ p.sellerName }} · {{ p.price > 0 ? `${fmtTokens(p.price)} tokens` : '免费' }} · 购于 {{ fmtTs(p.purchasedAt) }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <UBadge
                  size="sm"
                  variant="subtle"
                >
                  购买版 v{{ p.purchasedVersion }}
                </UBadge>
                <UFieldGroup>
                  <UButton
                    color="primary"
                    variant="soft"
                    size="sm"
                    icon="i-lucide-download"
                    :loading="isInstalling(p.id, verSel[p.id] ?? p.purchasedVersion)"
                    @click="onDownload(p.id, p.name, verSel[p.id] ?? p.purchasedVersion)"
                  >
                    下载 v{{ verSel[p.id] ?? p.purchasedVersion }}
                  </UButton>
                  <UDropdownMenu :items="boughtVersionItems(p)">
                    <UButton
                      color="primary"
                      variant="soft"
                      size="sm"
                      icon="i-lucide-chevron-down"
                      aria-label="选择下载版本"
                      class="border-l border-white/30"
                    />
                  </UDropdownMenu>
                </UFieldGroup>
              </div>
            </UCard>
          </li>
        </ul>
      </template>

      <!-- 我的发布 -->
      <template #published>
        <div
          v-if="!user"
          class="py-10 text-center text-sm text-neutral-500"
        >
          登录后查看你发布的 Skill
        </div>
        <div
          v-else-if="mineLoading"
          class="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          加载中…
        </div>
        <UCard v-else-if="!mine.published.length">
          <p class="py-6 text-center text-sm text-neutral-500">
            你还没有发布过 Skill
          </p>
        </UCard>
        <UTable
          v-else
          :data="mine.published"
          :columns="publishedColumns"
        >
          <template #name-cell="{ row }">
            <div class="min-w-0 pr-2">
              <p class="flex items-center gap-2 font-medium">
                <span class="min-w-0 truncate">{{ row.original.name }}</span>
                <UBadge
                  v-if="row.original.featured === 1"
                  color="primary"
                  size="sm"
                >
                  推荐
                </UBadge>
              </p>
              <p
                v-if="latestVersionOf(row.original)?.status === 'rejected' && latestVersionOf(row.original)?.rejectReason"
                class="mt-0.5 text-xs text-red-400"
              >
                拒绝原因:{{ latestVersionOf(row.original)?.rejectReason }}
              </p>
            </div>
          </template>
          <template #status-cell="{ row }">
            <UBadge
              :color="STATUS_BADGE_COLORS[rowStatusOf(row.original)]"
              variant="subtle"
            >
              {{ SKILL_STATUS_LABELS[rowStatusOf(row.original)] }}
            </UBadge>
          </template>
          <template #price-cell="{ row }">
            <UBadge
              v-if="row.original.price === 0"
              color="success"
              variant="subtle"
            >
              免费
            </UBadge>
            <span
              v-else
              class="text-sm tabular-nums"
            >
              {{ fmtTokens(row.original.price) }} tokens
            </span>
          </template>
          <template #downloadCount-cell="{ row }">
            <span class="text-sm">{{ row.original.downloadCount }}</span>
          </template>
          <template #updatedAt-cell="{ row }">
            <span class="text-sm">{{ fmtDay(latestVersionOf(row.original)?.createdAt ?? row.original.createdAt) }}</span>
          </template>
          <template #versions-cell="{ row }">
            <div class="flex items-center gap-2">
              <UBadge
                variant="subtle"
              >
                v{{ row.original.latestVersion }}
              </UBadge>
              <UButton
                color="neutral"
                variant="soft"
                size="sm"
                icon="i-lucide-history"
                @click="openVersions(row.original)"
              >
                版本管理
              </UButton>
            </div>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end">
              <UDropdownMenu
                :items="publishActionsItems(row.original)"
                :content="{ align: 'end' }"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  square
                  icon="i-lucide-ellipsis-vertical"
                  aria-label="操作菜单"
                />
              </UDropdownMenu>
            </div>
          </template>
        </UTable>
      </template>
    </UTabs>

    <!-- 购买确认弹窗:收费技能展示余额变化,二次确认后支付 -->
    <UModal
      v-model:open="buyOpen"
      :title="`${buyTarget && buyTarget.price > 0 ? '支付并获取' : '免费获取'}「${buyTarget?.name ?? ''}」`"
    >
      <template #body>
        <!-- 阶段 1:确认支付/免费获取 -->
        <template v-if="buyStage === 'confirm'">
          <template v-if="buyTarget && buyTarget.price > 0">
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
              将支付
              <span class="font-semibold text-highlighted">{{ fmtTokens(buyTarget.price) }} tokens</span>
              获取该 Skill,购买后永久可下载。发布者将获得售价的 80%,20% 为平台手续费。
            </p>
            <div class="mt-3 space-y-1.5 rounded-lg border border-neutral-200 px-3 py-2.5 text-sm dark:border-neutral-800">
              <p class="flex items-center justify-between gap-4">
                <span class="text-neutral-500">当前余额</span>
                <span class="tabular-nums text-highlighted">
                  {{ buyBalanceLoading ? '获取中…' : (buyBalance === null ? '—' : `${fmtTokens(buyBalance)} tokens`) }}
                </span>
              </p>
              <p class="flex items-center justify-between gap-4">
                <span class="text-neutral-500">支付金额</span>
                <span class="tabular-nums font-semibold text-red-500">- {{ fmtTokens(buyTarget.price) }} tokens</span>
              </p>
              <p class="flex items-center justify-between gap-4 border-t border-neutral-100 pt-1.5 dark:border-neutral-900">
                <span class="text-neutral-500">支付后余额</span>
                <span
                  class="tabular-nums font-medium"
                  :class="buyInsufficient ? 'text-red-500' : 'text-highlighted'"
                >
                  {{ buyBalanceLoading || buyBalance === null ? '—' : `${fmtTokens(Math.max(0, buyBalance - buyTarget.price))} tokens` }}
                </span>
              </p>
            </div>
            <p
              v-if="buyInsufficient"
              class="mt-2 text-xs text-red-500"
            >
              余额不足,请先到个人中心充值或兑换后再来获取
            </p>
          </template>
          <p
            v-else
            class="text-sm text-neutral-600 dark:text-neutral-400"
          >
            该 Skill 免费,获取后永久可下载。发布者可凭免费 Skill 获得更高展示与审核优先级。
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              @click="buyOpen = false"
            >
              取消
            </UButton>
            <UButton
              color="primary"
              :loading="buying"
              :disabled="buyInsufficient"
              @click="confirmBuy"
            >
              {{ buyTarget && buyTarget.price > 0 ? '确认支付' : '免费获取' }}
            </UButton>
          </div>
        </template>
        <!-- 阶段 2:购买完成,引导立即获取技能 -->
        <template v-else>
          <div class="text-center">
            <UIcon
              name="i-lucide-circle-check"
              class="mx-auto size-10 text-success"
            />
            <p class="mt-2 text-sm font-medium">
              {{ buyTarget && buyTarget.price > 0 ? '购买成功,该 Skill 永久可下载' : '获取成功,该 Skill 永久可下载' }}
            </p>
            <p class="mt-1 text-xs text-neutral-500">
              点击下方按钮立即安装到本地技能库并自动启用
            </p>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              @click="buyOpen = false"
            >
              稍后再说
            </UButton>
            <UButton
              color="primary"
              icon="i-lucide-download"
              @click="modalFetch"
            >
              获取技能
            </UButton>
          </div>
        </template>
      </template>
    </UModal>

    <!-- 下架 / 重新上架确认弹窗 -->
    <UModal
      v-model:open="statusOpen"
      :title="statusAction === 'unlist' ? '下架 Skill' : '重新上架 Skill'"
    >
      <template #body>
        <p
          v-if="statusAction === 'unlist'"
          class="text-sm text-neutral-600 dark:text-neutral-400"
        >
          下架后「{{ statusTarget?.name }}」将不再出现在商城,已购买用户仍可继续下载。再次上架需要重新审核。
        </p>
        <p
          v-else
          class="text-sm text-neutral-600 dark:text-neutral-400"
        >
          重新上架「{{ statusTarget?.name }}」后进入待审核状态,管理员审核通过后才会恢复在商城展示。
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="statusOpen = false"
          >
            取消
          </UButton>
          <UButton
            :color="statusAction === 'unlist' ? 'error' : 'primary'"
            :loading="statusBusy"
            @click="confirmStatus"
          >
            {{ statusAction === 'unlist' ? '确认下架' : '提交重新上架' }}
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 版本管理弹窗:列出全部版本,切换商城展示的主版本 -->
    <UModal
      v-model:open="versionsOpen"
      :title="`版本管理 · ${versionsTarget?.name ?? ''}`"
      :ui="{ content: 'max-w-xl' }"
    >
      <template #body>
        <UTable
          v-if="versionsTarget"
          :data="versionsTarget.versions"
          :columns="versionColumns"
        >
          <template #version-cell="{ row }">
            <span class="text-sm font-medium">v{{ row.original.version }}</span>
          </template>
          <template #createdAt-cell="{ row }">
            <span class="text-sm">
              {{ fmtTs(row.original.createdAt) }}
            </span>
          </template>
          <template #status-cell="{ row }">
            <div>
              <div class="flex items-center gap-1.5">
                <UBadge
                  :color="STATUS_BADGE_COLORS[row.original.status]"
                  variant="subtle"
                >
                  {{ SKILL_STATUS_LABELS[row.original.status] }}
                </UBadge>
                <UBadge
                  v-if="row.original.enabled === 0"
                  color="neutral"
                  variant="outline"
                  size="sm"
                >
                  已禁用
                </UBadge>
              </div>
              <p
                v-if="row.original.status === 'rejected' && row.original.rejectReason"
                class="mt-1 text-xs text-red-400"
              >
                拒绝原因:{{ row.original.rejectReason }}
              </p>
            </div>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex items-center justify-end gap-1.5">
              <UBadge
                v-if="row.original.version === mainVersionOf(versionsTarget)"
                color="primary"
                icon="i-lucide-star"
                size="sm"
                leading
              >
                当前主版本
              </UBadge>
              <template v-else-if="row.original.status === 'approved' && row.original.enabled === 1">
                <UButton
                  color="primary"
                  variant="soft"
                  size="sm"
                  :loading="setMainBusy === `${versionsTarget.id}:${row.original.version}`"
                  @click="onSetMainVersion(versionsTarget, row.original.version)"
                >
                  设为主版本
                </UButton>
                <UButton
                  color="neutral"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-eye-off"
                  :loading="setVersionBusy === `${versionsTarget.id}:${row.original.version}`"
                  @click="onToggleVersionEnabled(versionsTarget, row.original.version, false)"
                >
                  禁用
                </UButton>
              </template>
              <UButton
                v-else-if="row.original.status === 'approved' && row.original.enabled === 0"
                color="neutral"
                variant="soft"
                size="sm"
                icon="i-lucide-eye"
                :loading="setVersionBusy === `${versionsTarget.id}:${row.original.version}`"
                @click="onToggleVersionEnabled(versionsTarget, row.original.version, true)"
              >
                启用
              </UButton>
            </div>
          </template>
        </UTable>
        <p
          v-if="versionsTarget"
          class="mt-3 rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800"
        >
          主版本 = 商城中该 Skill 展示的名称/说明/价格快照,仅已上架版本可设为主版本,审核通过的新版本会自动成为主版本;禁用版本用户侧(商城/已购)不显示,已购者仍可下载购买锁定的版本,主版本不允许禁用。
        </p>
      </template>
    </UModal>

    <!-- 预览弹窗:未付费仅可看 README 摘要;免费/已购买可看全部 markdown -->
    <UModal
      v-model:open="previewOpen"
      :title="`预览 · ${previewData?.name ?? ''}`"
      :ui="{
        content: 'max-w-3xl'
      }"
    >
      <template #body>
        <p
          v-if="previewLoading"
          class="flex items-center justify-center gap-2 py-6 text-sm text-neutral-500"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          加载中…
        </p>
        <p
          v-else-if="previewError"
          class="py-6 text-center text-sm text-red-500"
        >
          {{ previewError }}
        </p>
        <div
          v-else-if="previewData && previewData.files.length"
          class="grid grid-cols-[170px_1fr] gap-4"
        >
          <ul class="max-h-[65vh] divide-y divide-neutral-100 overflow-y-auto font-mono text-xs dark:divide-neutral-900">
            <li
              v-for="(f, i) in previewData.files"
              :key="f.name"
            >
              <button
                type="button"
                class="w-full truncate px-2 py-1.5 text-left transition-colors"
                :class="i === previewIdx
                  ? 'bg-primary/10 text-primary'
                  : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900'"
                @click="onPreviewFile(i)"
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
        <div
          v-else-if="previewData && !previewData.canViewAll"
          class="max-h-[65vh] overflow-y-auto pr-1"
        >
          <p class="mb-2 text-xs font-medium text-neutral-400">
            README 预览(压缩包内 README 文件内容)
          </p>
          <p class="whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            {{ previewData.readme || '发布者尚未提供可预览内容' }}
          </p>
        </div>
        <p
          v-else-if="previewData"
          class="py-6 text-center text-sm text-neutral-500"
        >
          压缩包内没有可预览的 markdown 文件
        </p>
        <p
          v-if="previewData && !previewData.canViewAll"
          class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
        >
          未购买,仅可预览 README 摘要(压缩包共 {{ previewData.entryCount ?? previewData.entries.length }} 个文件);{{ previewData.price > 0 ? '购买后' : '免费获取后' }}可查看全部文件内容
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
.md-preview :deep(blockquote) {
  margin: 0.5rem 0;
  padding-left: 0.75rem;
  border-left: 2px solid var(--ui-border);
  color: var(--ui-text-muted);
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
