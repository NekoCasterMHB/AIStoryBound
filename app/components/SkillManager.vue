<script setup lang="ts">
// SkillManager.vue — 「技能管理」通用组件(个人中心 Tab 等任意页面可嵌入):
// 列出从 Skill 商城下载的本地技能,逐项开关启用、删除本地副本、一键全部开关。
// 开启的技能会在游玩时注入叙事提示词(由调用方通过 loadEnabledAiSkillObjects 读取)。
import {
  listInstalledSkills, loadEnabledAiSkills, saveEnabledAiSkills, deleteUserSkill, installStoreSkillZip
} from '../utils/aiSkills'
import type { AiSkill } from '#shared/ai-skills'
import type { StoreSkillSummary } from '#shared/store-skill'

const toast = useToast()

const skills = ref<AiSkill[]>([])
const enabled = ref<string[]>([])
/** 商城在售商品映射(key=商城商品 id,即本地技能 key;商品下架/删除后可能缺失) */
const storeSkills = ref<Record<string, { name: string, sellerName: string, latestVersion?: number }>>({})

function sellerOf(key: string): string | undefined {
  return storeSkills.value[key]?.sellerName
}

/** 展示名称以商城为准(商品下架/删除后回退本地 SKILL.md 名称) */
function displayName(s: AiSkill | null): string {
  if (!s) return ''
  return storeSkills.value[s.key]?.name || s.name
}

/** 本地落后的目标版本号:有本地版本记录且商城最新启用版本更新时返回目标版本,否则 null */
function updateTarget(s: AiSkill): number | null {
  if (typeof s.storeVersion !== 'number') return null
  const latest = storeSkills.value[s.key]?.latestVersion
  if (typeof latest !== 'number' || latest <= s.storeVersion) return null
  return latest
}

async function refresh() {
  skills.value = await listInstalledSkills()
  enabled.value = loadEnabledAiSkills()
  // 每次查看都检查更新:作者与最新版本号来自商城公开接口,老安装(未带版本记录)也能对比
  try {
    const list = await $fetch<StoreSkillSummary[]>('/api/store/skills')
    const map: Record<string, { name: string, sellerName: string, latestVersion?: number }> = {}
    for (const s of list) {
      map[s.id] = { name: s.name, sellerName: s.sellerName, latestVersion: s.versions[0]?.version }
    }
    storeSkills.value = map
  } catch {
    storeSkills.value = {}
  }
}

onMounted(() => {
  void refresh()
})

const enabledCount = computed(() => skills.value.filter(s => enabled.value.includes(s.key)).length)

/** 文本 → 预估 token:中文/全角按 1 字 ≈ 1 token,其余字符按 4 字符 ≈ 1 token */
function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if ((ch >= '\u4e00' && ch <= '\u9fff') || (ch >= '\u3000' && ch <= '\u303f') || (ch >= '\uff00' && ch <= '\uffef')) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/** 已启用技能注入叙事提示词的内容量(正文 + 随附附件),预估 token 消耗 */
const enabledTokenEstimate = computed(() => {
  let tokens = 0
  for (const s of skills.value) {
    if (!enabled.value.includes(s.key)) continue
    tokens += estimateTokens(s.body)
    for (const a of s.attachments ?? []) tokens += estimateTokens(a.text)
  }
  return tokens
})

function isOn(s: AiSkill) {
  return enabled.value.includes(s.key)
}

function toggle(s: AiSkill, v: boolean) {
  const next = new Set(enabled.value)
  if (v) next.add(s.key)
  else next.delete(s.key)
  enabled.value = [...next]
  saveEnabledAiSkills(enabled.value)
}

function setAll(v: boolean) {
  enabled.value = v ? skills.value.map(s => s.key) : []
  saveEnabledAiSkills(enabled.value)
}

/** 删除本地副本(仅移除本机注册与开关,不影响商城购买记录,可随时重新下载) */
const removeTarget = ref<AiSkill | null>(null)
const removeOpen = ref(false)
const removing = ref(false)

function askRemove(s: AiSkill) {
  removeTarget.value = s
  removeOpen.value = true
}

async function confirmRemove() {
  const target = removeTarget.value
  if (!target) return
  removing.value = true
  try {
    await deleteUserSkill(target.key)
    await refresh()
    removeOpen.value = false
    toast.add({ title: '已删除', description: `「${target.name}」本地副本已移除,可在 Skill 商城重新下载`, color: 'success' })
  } catch (e) {
    toast.add({ title: '删除失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    removing.value = false
  }
}

/** 拉取商城最新版本 zip 并安装(同名覆盖,自动启用),随后刷新列表 */
const updatingKey = ref('')

async function updateSkill(s: AiSkill) {
  const version = updateTarget(s)
  if (!version) return
  updatingKey.value = s.key
  try {
    const blob = await $fetch<Blob>(`/api/store/skills/${s.key}/download?version=${version}`, { responseType: 'blob' })
    const zip = new Uint8Array(await blob.arrayBuffer())
    const skill = await installStoreSkillZip(zip, s.key, version, displayName(s))
    toast.add({ title: '已更新', description: `「${skill.name}」已更新到 v${version} 并自动启用`, color: 'success' })
    await refresh()
  } catch (e) {
    toast.add({ title: '更新失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    updatingKey.value = ''
  }
}
</script>

<template>
  <UCard class="mb-6">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-col gap-1">
        <p class="font-semibold">
          已下载技能
        </p>
        <p class="text-xs text-neutral-500">
          来自 Skill 商城;开启的技能会注入游玩叙事提示词(未开启尽量不出现)。已开启 {{ enabledCount }}/{{ skills.length }}
        </p>
        <p
          v-if="enabledTokenEstimate > 0"
          class="mt-1 text-xs text-amber-600 dark:text-amber-400"
        >
          💡 已启用内容(正文+附件)约 {{ enabledTokenEstimate.toLocaleString('zh-CN') }} tokens,将计入每次叙事的上下文消耗
        </p>
      </div>
      <div class="flex gap-2">
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-shopping-bag"
          to="/store"
        >
          去商城
        </UButton>
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          @click="setAll(true)"
        >
          全部开启
        </UButton>
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          @click="setAll(false)"
        >
          全部关闭
        </UButton>
      </div>
    </div>

    <div
      v-if="skills.length === 0"
      class="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700"
    >
      还没有下载过技能——去 <NuxtLink
        to="/store"
        class="text-primary-500 underline"
      >Skill 商城</NuxtLink> 选购一个,下载后会自动启用并加载
    </div>

    <div
      v-else
      class="grid gap-1.5 sm:grid-cols-2"
    >
      <div
        v-for="s in skills"
        :key="s.key"
        class="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
      >
        <div class="min-w-0">
          <p class="flex items-center gap-1.5 text-sm font-medium">
            <span class="truncate">{{ displayName(s) }}</span>
            <UBadge
              v-if="typeof s.storeVersion === 'number'"
              size="sm"
              variant="subtle"
              class="shrink-0"
            >
              v{{ s.storeVersion }}
            </UBadge>
          </p>
          <p
            v-if="sellerOf(s.key)"
            class="mt-0.5 truncate text-xs text-neutral-500"
          >
            作者:{{ sellerOf(s.key) }}
          </p>
          <p class="mt-0.5 line-clamp-3 text-xs leading-relaxed text-neutral-500">
            {{ s.desc }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <UButton
            v-if="updateTarget(s)"
            icon="i-lucide-refresh-cw"
            color="success"
            variant="soft"
            size="xs"
            :loading="updatingKey === s.key"
            @click="updateSkill(s)"
          >
            更新版本
          </UButton>
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="xs"
            :aria-label="`删除 ${s.name}`"
            @click="askRemove(s)"
          />
          <USwitch
            :model-value="isOn(s)"
            @update:model-value="v => toggle(s, v)"
          />
        </div>
      </div>
    </div>
  </UCard>

  <!-- 删除确认弹窗:仅移除本机副本,不影响商城购买记录 -->
  <UModal
    v-model:open="removeOpen"
    :title="`删除技能「${displayName(removeTarget)}」`"
  >
    <template #body>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        将删除「{{ removeTarget?.name }}」的本地副本并从启用列表移除,删除后可随时在 Skill 商城重新下载,不影响你的购买记录。
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          @click="removeOpen = false"
        >
          取消
        </UButton>
        <UButton
          color="error"
          :loading="removing"
          @click="confirmRemove"
        >
          确认删除
        </UButton>
      </div>
    </template>
  </UModal>
</template>
