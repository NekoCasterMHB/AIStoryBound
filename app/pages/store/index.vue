<script setup lang="ts">
import { useAuthSession } from '../../utils/auth-client'
import { useAuthModal } from '../../composables/useAuthModal'
import { SKILL_STATUS_LABELS } from '../../../shared/store-skill'
import type { MyPublishedSkill, SkillStatus, StoreSkillSummary } from '../../../shared/store-skill'

// /store — Skill 商城(游客可浏览;购买/我的需登录)。
useHead({ title: 'AI SpankWorld · Skill 商城' })

const { data: session } = await useAuthSession()
const user = computed(() => session.value?.user)
const { requireLogin } = useAuthModal()
const toast = useToast()

const STATUS_COLORS: Record<SkillStatus, string> = {
  pending: 'text-amber-600',
  approved: 'text-emerald-600',
  rejected: 'text-red-500',
  removed: 'text-neutral-400'
}

// ---- 数据 ----
const skills = ref<StoreSkillSummary[]>([])
const loading = ref(false)
const mineLoading = ref(false)
const mine = ref<{ purchased: import('../../../shared/store-skill').MyPurchasedSkill[], published: import('../../../shared/store-skill').MyPublishedSkill[] }>({ purchased: [], published: [] })

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
  if (user.value) void loadMine()
})

function fmtTokens(n: number) {
  return n.toLocaleString('zh-CN')
}
function fmtTs(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
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

async function onBuy(skill: StoreSkillSummary) {
  const ok = await requireLogin()
  if (!ok) return
  buyTarget.value = skill
  buyOpen.value = true
}

async function confirmBuy() {
  const target = buyTarget.value
  if (!target) return
  buying.value = true
  try {
    const res = await $fetch<{ ok: true, price: number }>(`/api/store/skills/${target.id}/purchase`, { method: 'POST' })
    buyOpen.value = false
    toast.add({
      title: res.price > 0 ? `购买成功,已扣除 ${fmtTokens(res.price)} tokens` : '已免费获取,永久可下载',
      description: res.price > 0 ? '购买后永久可下载;发布者将获得其中的 80%' : '免费 Skill 在商城拥有更高展示优先级',
      color: 'success'
    })
    await loadSkills()
    if (user.value) await loadMine()
  } catch (e) {
    toast.add({ title: '购买失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    buying.value = false
  }
}

function downloadUrl(id: string, version?: number) {
  return `/api/store/skills/${id}/download${version ? `?version=${version}` : ''}`
}

/** 我的发布里最新提交的版本(行状态以最新版本为准) */
function latestVersionOf(p: MyPublishedSkill) {
  return p.versions[0] ?? null
}

/** 「历史版本」下拉项:发布者可下载任意版本 */
function versionItems(p: MyPublishedSkill) {
  return [
    p.versions.map(v => ({
      label: `v${v.version} · ${SKILL_STATUS_LABELS[v.status]} · ${fmtTs(v.createdAt)}`,
      icon: 'i-lucide-download',
      onSelect: () => { window.open(downloadUrl(p.id, v.version), '_blank') }
    }))
  ]
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          Skill 商城
        </h1>
        <p class="mt-1 text-sm text-neutral-500">
          用 token 选购 agent skill,购买后永久可下载;你也可以发布自己的 skill 赚取 token
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
      @update:model-value="onTabChange"
      variant="link"
      :items="[
        { label: '全部', value: 'all', slot: 'all' },
        { label: '我的购买', value: 'bought', slot: 'bought' },
        { label: '我的发布', value: 'published', slot: 'published' }
      ]"
      class="mb-6"
    >
      <!-- 全部:商品卡片 -->
      <template #all>
        <div v-if="loading" class="py-10 text-center text-sm text-neutral-500">
          加载中…
        </div>
        <div v-else-if="!skills.length" class="py-10 text-center text-sm text-neutral-500">
          商城还没有商品,成为第一个发布者吧
        </div>
        <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <UCard v-for="s in skills" :key="s.id" class="flex flex-col">
            <div class="flex items-start justify-between gap-2">
              <p class="truncate font-semibold">
                {{ s.name }}
              </p>
              <UBadge v-if="s.featured === 1" color="primary" size="sm" class="shrink-0">
                <UIcon name="i-lucide-star" class="size-3" />
                推荐
              </UBadge>
            </div>
            <p class="mt-2 line-clamp-2 min-h-10 text-sm text-neutral-500">
              {{ s.desc }}
            </p>
            <p class="mt-3 flex items-center gap-1 text-xs text-neutral-400">
              <UIcon name="i-lucide-user-round" class="size-3.5" />
              发布者:{{ s.sellerName }}
            </p>
            <div class="mt-4 flex items-center justify-between gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-900">
              <p class="text-sm tabular-nums">
                <template v-if="s.price > 0">
                  <span class="font-semibold text-(--ui-text-highlighted)">{{ fmtTokens(s.price) }}</span>
                  <span class="text-neutral-500"> tokens</span>
                </template>
                <span v-else class="font-semibold text-success">免费</span>
              </p>
              <UButton
                v-if="s.owned"
                :to="downloadUrl(s.id)"
                color="success"
                variant="soft"
                size="sm"
                icon="i-lucide-download"
                target="_blank"
              >
                下载
              </UButton>
              <UButton
                v-else
                color="primary"
                size="sm"
                :icon="s.price > 0 ? 'i-lucide-shopping-cart' : 'i-lucide-gift'"
                @click="onBuy(s)"
              >
                {{ s.price > 0 ? '购买' : '免费获取' }}
              </UButton>
            </div>
            <p class="mt-2 text-[11px] text-neutral-400">
              已售 {{ s.purchaseCount }} · 下载 {{ s.downloadCount }}
            </p>
          </UCard>
        </div>
      </template>

      <!-- 我的购买 -->
      <template #bought>
        <div v-if="!user" class="py-10 text-center text-sm text-neutral-500">
          登录后查看已购买的 Skill
        </div>
        <div v-else-if="mineLoading" class="py-10 text-center text-sm text-neutral-500">
          加载中…
        </div>
        <UCard v-else-if="!mine.purchased.length">
          <p class="py-6 text-center text-sm text-neutral-500">
            还没有购买记录,去「全部」挑一个吧
          </p>
        </UCard>
        <ul v-else class="space-y-3">
          <li v-for="p in mine.purchased" :key="p.id">
            <UCard class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="flex items-center gap-2 truncate font-medium">
                  {{ p.name }}
                  <UBadge v-if="p.featured === 1" color="primary" size="sm">
                    推荐
                  </UBadge>
                </p>
                <p class="mt-0.5 text-xs text-neutral-500">
                  {{ p.sellerName }} · {{ p.price > 0 ? `${fmtTokens(p.price)} tokens` : '免费' }} · 购于 {{ fmtTs(p.purchasedAt) }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <UBadge size="sm" variant="subtle">
                  购买版 v{{ p.purchasedVersion }}
                </UBadge>
                <UButton
                  :to="downloadUrl(p.id, p.purchasedVersion)"
                  color="primary"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-download"
                  target="_blank"
                >
                  重新下载
                </UButton>
                <UButton
                  v-if="p.versions.some(v => v > p.purchasedVersion)"
                  :to="downloadUrl(p.id, Math.max(...p.versions))"
                  color="neutral"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-download"
                  target="_blank"
                >
                  最新版 v{{ Math.max(...p.versions) }}
                </UButton>
              </div>
            </UCard>
          </li>
        </ul>
      </template>

      <!-- 我的发布 -->
      <template #published>
        <div v-if="!user" class="py-10 text-center text-sm text-neutral-500">
          登录后查看你发布的 Skill
        </div>
        <div v-else-if="mineLoading" class="py-10 text-center text-sm text-neutral-500">
          加载中…
        </div>
        <UCard v-else-if="!mine.published.length">
          <p class="py-6 text-center text-sm text-neutral-500">
            你还没有发布过 Skill
          </p>
        </UCard>
        <ul v-else class="space-y-3">
          <li v-for="p in mine.published" :key="p.id">
            <UCard class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="flex items-center gap-2 truncate font-medium">
                  {{ p.name }}
                  <UBadge size="sm" variant="subtle">
                    v{{ p.latestVersion }}
                  </UBadge>
                  <UBadge v-if="p.featured === 1" color="primary" size="sm">
                    推荐
                  </UBadge>
                </p>
                <p class="mt-0.5 text-xs text-neutral-500">
                  {{ p.price > 0 ? `${fmtTokens(p.price)} tokens` : '免费' }} · 已售 {{ p.purchaseCount }} · 下载 {{ p.downloadCount }} ·
                  {{ fmtTs(p.createdAt) }} 提交
                </p>
                <p v-if="latestVersionOf(p)?.status === 'rejected' && latestVersionOf(p)?.rejectReason" class="mt-1 text-xs text-red-400">
                  拒绝原因:{{ latestVersionOf(p)?.rejectReason }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <span :class="STATUS_COLORS[latestVersionOf(p)?.status ?? p.status]" class="text-sm">
                  {{ SKILL_STATUS_LABELS[latestVersionOf(p)?.status ?? p.status] }}
                </span>
                <UDropdownMenu :items="versionItems(p)">
                  <UButton
                    color="neutral"
                    variant="soft"
                    size="sm"
                    icon="i-lucide-history"
                  >
                    历史版本
                  </UButton>
                </UDropdownMenu>
                <UButton
                  :to="`/store/publish?skill=${p.id}`"
                  color="primary"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-upload"
                >
                  更新版本
                </UButton>
                <UButton
                  :to="downloadUrl(p.id, p.latestVersion)"
                  color="neutral"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-download"
                  target="_blank"
                >
                  下载包
                </UButton>
              </div>
            </UCard>
          </li>
        </ul>
      </template>
    </UTabs>

    <!-- 购买确认弹窗 -->
    <UModal v-model:open="buyOpen" :title="`${buyTarget && buyTarget.price > 0 ? '购买' : '免费获取'}「${buyTarget?.name ?? ''}」`">
      <template #body>
        <p v-if="buyTarget && buyTarget.price > 0" class="text-sm text-neutral-600 dark:text-neutral-400">
          将以
          <span class="font-semibold text-(--ui-text-highlighted)">{{ fmtTokens(buyTarget.price) }} tokens</span>
          购买该 Skill,购买后永久可下载。发布者将获得售价的 80%,20% 为平台手续费。
        </p>
        <p v-else class="text-sm text-neutral-600 dark:text-neutral-400">
          该 Skill 免费,获取后永久可下载。发布者可凭免费 Skill 获得更高展示与审核优先级。
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton color="neutral" variant="outline" @click="buyOpen = false">
            取消
          </UButton>
          <UButton color="primary" :loading="buying" @click="confirmBuy">
            {{ buyTarget && buyTarget.price > 0 ? '确认购买' : '免费获取' }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>