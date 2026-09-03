<script setup lang="ts">
import { useAuthSession } from '~/utils/auth-client'
import { useAuthModal } from '~/composables/useAuthModal'
import { getWork } from '~/utils/worldGen'
import { getInstalledNovels, installStoreNovel } from '~/utils/novelStore'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { NOVEL_STATUS_LABELS, fmtNovelChars } from '#shared/store-novel'
import type { MyPublishedNovel, MyPurchasedNovel, NovelStatus, NovelVersionBrief, StoreNovelSummary } from '#shared/store-novel'
import type { LocalWork } from '#shared/novel'

// 小说商城面板(创意工坊「书架」tab;游客可浏览;购买/我的需登录)。
// 交易规则与 Skill 商城一致:支付 token,卖家得售价 80%,20% 平台手续费;发布者设定可免费试读字数。

const { data: session } = await useAuthSession()
const user = computed(() => session.value?.user)
const { requireLogin } = useAuthModal()
const toast = useToast()

/** 「我的发布」表格状态徽章颜色 */
const STATUS_BADGE_COLORS: Record<NovelStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
  removed: 'neutral'
}

// ---- 数据 ----
const novels = ref<StoreNovelSummary[]>([])
// 初始即 true:避免首帧渲染出"书架还没有小说"空状态(onMounted 前 loading 为 false)
const loading = ref(true)
const mineLoading = ref(true)
const mine = ref<{ purchased: MyPurchasedNovel[], published: MyPublishedNovel[] }>({ purchased: [], published: [] })

async function loadNovels() {
  loading.value = true
  try {
    novels.value = await $fetch<StoreNovelSummary[]>('/api/store/novels')
  } catch (e) {
    toast.add({ title: '加载书架失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
async function loadMine() {
  mineLoading.value = true
  try {
    mine.value = await $fetch('/api/store/novels/mine')
  } catch (e) {
    toast.add({ title: '加载我的数据失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    mineLoading.value = false
  }
}

/** 本地已安装的书架作品(novelId → 本地 work;work=null 表示映射失效,需重新安装) */
const installed = ref<Record<string, { workId: string, work: LocalWork | null }>>({})

async function loadInstalled() {
  const map = getInstalledNovels()
  const out: Record<string, { workId: string, work: LocalWork | null }> = {}
  await Promise.all(Object.entries(map).map(async ([id, rec]) => {
    try {
      const work = await getWork(rec.workId)
      out[id] = { workId: rec.workId, work }
    } catch {
      out[id] = { workId: rec.workId, work: null }
    }
  }))
  installed.value = out
}

onMounted(() => {
  void loadNovels()
  void loadInstalled()
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
const buyTarget = ref<StoreNovelSummary | null>(null)
const buyOpen = ref(false)
const buying = ref(false)
/** 购买模态框阶段:confirm=确认购买 / fetch=购买完成,引导立即获取加入书架 */
const buyStage = ref<'confirm' | 'fetch'>('confirm')
/** 确认框展示的当前余额(收费小说打开时从 /api/profile/me 拉取,供显示支付后余额) */
const buyBalance = ref<number | null>(null)
const buyBalanceLoading = ref(false)
/** 余额已知且不足以支付时,确认按钮禁用并提示充值 */
const buyInsufficient = computed(() => {
  const t = buyTarget.value
  const b = buyBalance.value
  return !!t && t.price > 0 && b !== null && b < t.price
})

async function onBuy(novel: StoreNovelSummary) {
  const ok = await requireLogin()
  if (!ok) return
  buyTarget.value = novel
  buyStage.value = 'confirm'
  buyOpen.value = true
  buyBalance.value = null
  if (novel.price > 0) {
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
    const res = await $fetch<{ ok: true, price: number }>(`/api/store/novels/${target.id}/purchase`, { method: 'POST' })
    toast.add({
      title: res.price > 0 ? `购买成功,已扣除 ${fmtTokens(res.price)} tokens` : '已免费获取,永久可下载',
      description: res.price > 0 ? '购买后永久可下载;发布者将获得其中的 80%,收益在个人中心领取后到账' : '免费小说在书架拥有更高展示优先级',
      color: 'success'
    })
    // 购买完成 → 切换为"获取"阶段,引导立即加入本地书架
    buyStage.value = 'fetch'
    await loadNovels()
    if (user.value) await loadMine()
  } catch (e) {
    toast.add({ title: '购买失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    buying.value = false
  }
}

/** 模态框「获取」:安装后关闭模态框,卡片随即显示「已加入书架」 */
async function modalFetch() {
  const target = buyTarget.value
  if (!target) return
  await onFetch(target.id, defaultNovelVersion(target), target)
  buyOpen.value = false
  buyStage.value = 'confirm'
  buyTarget.value = null
}

// ---- 获取 = 安装到本地书架:拉取 TXT → 解析章节 → 落 IndexedDB works ----
const installingKey = ref('')

function isInstalling(id: string, version?: number) {
  return installingKey.value === `${id}:${version ?? 'default'}`
}

async function onFetch(id: string, version: number | undefined, novel: Pick<StoreNovelSummary, 'title' | 'author'>) {
  if (installingKey.value) return
  installingKey.value = `${id}:${version ?? 'default'}`
  try {
    await installStoreNovel({ id, title: novel.title, author: novel.author, version })
    await loadInstalled()
    const work = installed.value[id]?.work
    toast.add({
      title: '已加入书架',
      description: work
        ? `「${novel.title}」已加入我的书架,可直接阅读或生成世界开始扮演`
        : `「${novel.title}」已加入我的书架`,
      color: 'success'
    })
  } catch (e) {
    toast.add({
      title: '获取小说失败',
      description: e instanceof Error ? e.message : String(e),
      color: 'error'
    })
  } finally {
    installingKey.value = ''
  }
}

/** 卡片上当前选中的获取版本(默认主版本,未设置主版本时取最新已上架版本) */
function defaultNovelVersion(s: StoreNovelSummary | null): number | undefined {
  if (!s) return undefined
  return verSel[s.id] ?? cardMainVersion(s) ?? undefined
}

/** 卡片「当前主版本」:发布者手动指定优先,否则最新已上架版本(versions[0]) */
function cardMainVersion(s: StoreNovelSummary): number | null {
  if (typeof s.mainVersion === 'number' && s.versions.some(v => v.version === s.mainVersion)) return s.mainVersion
  return s.versions[0]?.version ?? null
}

/** 卡片「获取」按钮文案:选中的是主版本时不带版本号;其余版本带版本号 */
function fetchLabel(s: StoreNovelSummary): string {
  const ver = defaultNovelVersion(s)
  if (typeof ver !== 'number') return '获取'
  return ver === cardMainVersion(s) ? '获取' : `获取 v${ver}`
}

/** 卡片「获取」的版本菜单:开头「获取特定版本」标题,每个版本独立分组(组间分割线),当前选中项打勾,主版本带「主版本」标记 */
function cardVersionItems(s: StoreNovelSummary) {
  const main = cardMainVersion(s)
  return [
    [{ type: 'label' as const, label: '获取特定版本' }],
    ...s.versions.map(v => [{
      label: `v${v.version} · 发布于:${fmtDay(v.createdAt)}`,
      icon: v.version === defaultNovelVersion(s) ? 'i-lucide-check' : 'i-lucide-download',
      kbds: v.version === main ? ['主版本'] : undefined,
      onSelect: () => { verSel[s.id] = v.version }
    }])
  ]
}

/** 本地已装版本是否落后于卡片默认获取的版本(默认=主版本) */
function hasNovelUpdate(s: StoreNovelSummary): boolean {
  const rec = getInstalledNovels()[s.id]
  if (!rec || typeof rec.version !== 'number') return false
  const target = defaultNovelVersion(s)
  return typeof target === 'number' && rec.version < target
}

/** 我的发布里最新提交的版本(行状态以最新版本为准) */
function latestVersionOf(p: MyPublishedNovel) {
  return p.versions[0] ?? null
}

/** 行状态:下架/整体待审以主表为准;在售商品展示最新提交版本的审核状态 */
function rowStatusOf(p: MyPublishedNovel): NovelStatus {
  if (p.status !== 'approved') return p.status
  return latestVersionOf(p)?.status ?? p.status
}

/** 「我的发布」表格列:书名 / 状态 / 售价 / 下载次数 / 最后更新 / 版本 / 操作 */
const publishedColumns: TableColumn<MyPublishedNovel>[] = [
  { id: 'title', header: '书名' },
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
const versionColumns: TableColumn<NovelVersionBrief>[] = [
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

/** 每行选中的下载版本(默认购买版/最新提交版),key=小说 id */
const verSel = reactive<Record<string, number>>({})

/** 「我的购买」版本菜单:购买锁定版(标注购买版)+ 后续已上架版本(发布时间) */
function boughtVersionItems(p: MyPurchasedNovel) {
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
function publishActionsItems(p: MyPublishedNovel) {
  const items: DropdownMenuItem[] = [
    { label: '更新版本', icon: 'i-lucide-upload', color: 'success', onSelect: () => navigateTo(`/workshop/publish?novel=${p.id}`) }
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
const versionsTarget = ref<MyPublishedNovel | null>(null)
const setMainBusy = ref('')

function openVersions(p: MyPublishedNovel) {
  versionsTarget.value = p
  versionsOpen.value = true
}

/** 当前主版本:手动设置者优先,否则最新已上架版本 */
function mainVersionOf(p: MyPublishedNovel): number | null {
  if (p.mainVersion) return p.mainVersion
  return p.versions.find(v => v.status === 'approved')?.version ?? null
}

async function onSetMainVersion(p: MyPublishedNovel, version: number) {
  setMainBusy.value = `${p.id}:${version}`
  try {
    await $fetch(`/api/store/novels/${p.id}/version`, { method: 'POST', body: { version, main: true } })
    toast.add({
      title: '已切换主版本',
      description: `书架商城将以 v${version} 的书名/简介/价格/试读字数展示`,
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

async function onToggleVersionEnabled(p: MyPublishedNovel, version: number, enabled: boolean) {
  const key = `${p.id}:${version}`
  setVersionBusy.value = key
  try {
    await $fetch(`/api/store/novels/${p.id}/version`, { method: 'POST', body: { version, enabled } })
    toast.add({
      title: enabled ? `已启用 v${version}` : `已禁用 v${version}`,
      description: enabled
        ? '该版本已恢复在用户侧(书架商城/已购)显示'
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

// ---- 下架 / 重新上架(下架后从书架商城隐藏;重新上架需管理员再次审核) ----
const statusTarget = ref<MyPublishedNovel | null>(null)
const statusAction = ref<'unlist' | 'relist'>('unlist')
const statusOpen = ref(false)
const statusBusy = ref(false)

function onUnlist(p: MyPublishedNovel) {
  statusTarget.value = p
  statusAction.value = 'unlist'
  statusOpen.value = true
}

function onRelist(p: MyPublishedNovel) {
  statusTarget.value = p
  statusAction.value = 'relist'
  statusOpen.value = true
}

async function confirmStatus() {
  const target = statusTarget.value
  if (!target) return
  statusBusy.value = true
  try {
    await $fetch(`/api/store/novels/${target.id}/status`, {
      method: 'POST',
      body: { status: statusAction.value === 'unlist' ? 'removed' : 'pending' }
    })
    statusOpen.value = false
    toast.add({
      title: statusAction.value === 'unlist' ? '已下架' : '已提交重新上架',
      description: statusAction.value === 'unlist'
        ? '小说已从书架商城下架,已购买用户仍可下载;可随时重新上架(需再次审核)'
        : '已进入待审核,管理员审核通过后恢复在书架商城展示',
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

// ---- 试读(商城卡片):未购买仅可读前 previewChars 字(发布者设定) ----
interface NovelPreviewData {
  id: string
  title: string
  author: string | null
  desc: string
  price: number
  previewChars: number
  totalChars: number
  canViewAll: boolean
  /** 前 previewChars 字正文(未付费可读部分) */
  preview: string
}
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const previewData = ref<NovelPreviewData | null>(null)

async function onPreview(s: StoreNovelSummary) {
  previewOpen.value = true
  previewLoading.value = true
  previewError.value = ''
  previewData.value = null
  try {
    previewData.value = await $fetch<NovelPreviewData>(`/api/store/novels/${s.id}/preview`)
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-xl font-semibold">
          <UIcon
            name="i-lucide-book-open"
            class="size-5 text-primary"
          />
          书架
        </h2>
        <p class="mt-1 text-sm text-neutral-500">
          用 token 购买小说,加入书架后可阅读,也能用 AI 生成世界亲自扮演;发布自己的小说同样能赚取 token
        </p>
      </div>
      <UButton
        to="/workshop/publish"
        color="primary"
        icon="i-lucide-upload"
      >
        发布小说
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
      <!-- 全部:小说卡片 -->
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
          v-else-if="!novels.length"
          class="py-10 text-center text-sm text-neutral-500"
        >
          书架还没有小说,成为第一个发布者吧
        </div>
        <div
          v-else
          class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <UCard
            v-for="s in novels"
            :key="s.id"
            class="flex flex-col"
            :ui="{ body: 'flex-1' }"
          >
            <!-- 第一行:方形圆角图标 + 书名 + 版本/推荐徽章 -->
            <div class="flex items-start gap-3">
              <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <span class="text-2xl leading-none">📖</span>
              </div>
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 font-semibold">
                  <span class="min-w-0 truncate">{{ s.title }}</span>
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
                <p class="mt-1 truncate text-xs text-neutral-500">
                  作者: {{ s.author || '佚名' }}
                </p>
              </div>
            </div>
            <!-- 第二行:一句话简介,最多 2 行省略 -->
            <p class="mt-3 line-clamp-2 min-h-10 text-sm leading-relaxed text-neutral-500">
              {{ s.desc || '暂无简介' }}
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
                  v-if="s.previewChars > 0"
                  color="info"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-eye"
                  leading
                  class="tabular-nums"
                >
                  可试读 {{ s.previewChars.toLocaleString() }} 字
                </UBadge>
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
            <p class="mt-1 text-xs text-neutral-400">
              全书 {{ fmtNovelChars(s.totalChars) }}
            </p>
            <!-- Footer:试读(左)与获取/购买(右)分区,互不混排 -->
            <template #footer>
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <UButton
                    size="md"
                    variant="outline"
                    color="neutral"
                    icon="i-lucide-book-open"
                    aria-label="试读内容"
                    @click="onPreview(s)"
                  >
                    试读
                  </UButton>
                </div>
                <UFieldGroup
                  v-if="s.owned && !installed[s.id]"
                  class="flex-1"
                >
                  <UButton
                    block
                    color="primary"
                    size="md"
                    icon="i-lucide-download"
                    :loading="isInstalling(s.id, defaultNovelVersion(s))"
                    class="flex-1"
                    @click="onFetch(s.id, defaultNovelVersion(s), s)"
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
                  v-else-if="s.owned && hasNovelUpdate(s)"
                  color="success"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-refresh-cw"
                  :loading="isInstalling(s.id, defaultNovelVersion(s))"
                  @click="onFetch(s.id, defaultNovelVersion(s), s)"
                >
                  更新版本
                </UButton>
                <template v-else-if="s.owned">
                  <template v-if="installed[s.id]?.work">
                    <UButton
                      :to="`/read/work/${installed[s.id]?.workId}`"
                      color="success"
                      variant="soft"
                      size="sm"
                      icon="i-lucide-book-open"
                    >
                      阅读
                    </UButton>
                    <UButton
                      :to="`/generate?from=work&id=${installed[s.id]?.workId}`"
                      color="neutral"
                      variant="outline"
                      size="sm"
                      icon="i-lucide-sparkles"
                    >
                      生成世界
                    </UButton>
                  </template>
                  <UButton
                    v-else
                    color="primary"
                    variant="soft"
                    size="sm"
                    icon="i-lucide-download"
                    :loading="isInstalling(s.id, defaultNovelVersion(s))"
                    @click="onFetch(s.id, defaultNovelVersion(s), s)"
                  >
                    重新获取
                  </UButton>
                </template>
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
          登录后查看已购买的小说
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
            还没有购买记录,去「全部」挑一本吧
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
            <UCard>
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="flex items-center gap-2 truncate font-medium">
                    {{ p.title }}
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
                <div class="flex flex-wrap items-center gap-2">
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
                      @click="onFetch(p.id, verSel[p.id] ?? p.purchasedVersion, { title: p.title, author: null })"
                    >
                      {{ installed[p.id] ? '重新获取' : '获取' }}
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
              </div>
              <div
                v-if="installed[p.id]?.work"
                class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-3 dark:border-neutral-900"
              >
                <span class="text-xs text-neutral-500">已加入书架:</span>
                <UButton
                  :to="`/read/work/${installed[p.id]?.workId}`"
                  color="success"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-book-open"
                >
                  阅读
                </UButton>
                <UButton
                  :to="`/generate?from=work&id=${installed[p.id]?.workId}`"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  icon="i-lucide-sparkles"
                >
                  生成世界
                </UButton>
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
          登录后查看你发布的小说
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
            你还没有发布过小说
          </p>
        </UCard>
        <UTable
          v-else
          :data="mine.published"
          :columns="publishedColumns"
        >
          <template #title-cell="{ row }">
            <div class="min-w-0 pr-2">
              <p class="flex items-center gap-2 font-medium">
                <span class="min-w-0 truncate">{{ row.original.title }}</span>
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
              {{ NOVEL_STATUS_LABELS[rowStatusOf(row.original)] }}
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
              <UBadge variant="subtle">
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

    <!-- 购买确认弹窗:收费小说展示余额变化,二次确认后支付 -->
    <UModal
      v-model:open="buyOpen"
      :title="`${buyTarget && buyTarget.price > 0 ? '支付并获取' : '免费获取'}「${buyTarget?.title ?? ''}」`"
    >
      <template #body>
        <!-- 阶段 1:确认支付/免费获取 -->
        <template v-if="buyStage === 'confirm'">
          <template v-if="buyTarget && buyTarget.price > 0">
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
              将支付
              <span class="font-semibold text-highlighted">{{ fmtTokens(buyTarget.price) }} tokens</span>
              获取该小说,购买后永久可下载。发布者将获得售价的 80%,20% 为平台手续费;收益进入发布者个人中心「收益」,领取后到账。
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
            该小说免费,获取后永久可下载。发布者可凭免费小说获得更高展示与审核优先级。
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
        <!-- 阶段 2:购买完成,引导立即加入书架 -->
        <template v-else>
          <div class="text-center">
            <UIcon
              name="i-lucide-circle-check"
              class="mx-auto size-10 text-success"
            />
            <p class="mt-2 text-sm font-medium">
              {{ buyTarget && buyTarget.price > 0 ? '购买成功,该小说永久可下载' : '获取成功,该小说永久可下载' }}
            </p>
            <p class="mt-1 text-xs text-neutral-500">
              点击下方按钮立即加入本地书架,可在「我的书架」阅读或生成世界
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
              :loading="buyStage === 'fetch' && installingKey === `${buyTarget?.id}:${defaultNovelVersion(buyTarget) ?? 'default'}`"
              @click="modalFetch"
            >
              加入书架
            </UButton>
          </div>
        </template>
      </template>
    </UModal>

    <!-- 下架 / 重新上架确认弹窗 -->
    <UModal
      v-model:open="statusOpen"
      :title="statusAction === 'unlist' ? '下架小说' : '重新上架小说'"
    >
      <template #body>
        <p
          v-if="statusAction === 'unlist'"
          class="text-sm text-neutral-600 dark:text-neutral-400"
        >
          下架后「{{ statusTarget?.title }}」将不再出现在书架商城,已购买用户仍可继续下载。再次上架需要重新审核。
        </p>
        <p
          v-else
          class="text-sm text-neutral-600 dark:text-neutral-400"
        >
          重新上架「{{ statusTarget?.title }}」后进入待审核状态,管理员审核通过后才会恢复在书架商城展示。
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

    <!-- 版本管理弹窗:列出全部版本,切换书架商城展示的主版本 -->
    <UModal
      v-model:open="versionsOpen"
      :title="`版本管理 · ${versionsTarget?.title ?? ''}`"
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
                  {{ NOVEL_STATUS_LABELS[row.original.status] }}
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
          主版本 = 书架商城中该书展示的书名/简介/价格/试读字数快照,仅已上架版本可设为主版本,审核通过的新版本会自动成为主版本;禁用版本用户侧(书架商城/已购)不显示,已购者仍可下载购买锁定的版本,主版本不允许禁用。
        </p>
      </template>
    </UModal>

    <!-- 试读弹窗:未购买仅可读前 previewChars 字(发布者设定) -->
    <UModal
      v-model:open="previewOpen"
      :title="`试读 · ${previewData?.title ?? ''}`"
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
        <template v-else-if="previewData">
          <div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span>作者: {{ previewData.author || '佚名' }}</span>
            <span>·</span>
            <span>全书 {{ fmtNovelChars(previewData.totalChars) }}</span>
            <span>·</span>
            <span v-if="previewData.price > 0">
              售价 {{ fmtTokens(previewData.price) }} tokens
            </span>
            <span v-else>免费</span>
            <UBadge
              v-if="previewData.previewChars > 0"
              color="info"
              variant="soft"
              size="sm"
            >
              发布者开放试读前 {{ previewData.previewChars.toLocaleString() }} 字
            </UBadge>
            <UBadge
              v-else
              color="neutral"
              variant="outline"
              size="sm"
            >
              发布者未开放试读
            </UBadge>
          </div>
          <div class="max-h-[55vh] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/40">
            <p
              v-if="previewData.preview"
              class="whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
            >
              {{ previewData.preview }}
            </p>
            <p
              v-else
              class="py-6 text-center text-sm text-neutral-500"
            >
              发布者未开放试读,购买后可获取全文
            </p>
          </div>
          <p
            v-if="!previewData.canViewAll"
            class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
          >
            未购买,仅可试读前 {{ previewData.previewChars.toLocaleString() }} 字(发布者设定);{{ previewData.price > 0 ? '支付后' : '免费获取后' }}可下载全文,加入书架阅读或生成世界
          </p>
          <p
            v-else
            class="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          >
            你已拥有该小说,可获取全文加入书架阅读
          </p>
        </template>
      </template>
    </UModal>
  </div>
</template>
