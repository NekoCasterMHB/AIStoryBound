<script setup lang="ts">
import { AI_API_FORMATS, aiFormatMeta, type AiApiFormat, AI_ROUTE_ENV } from '#shared/ai-config'

// /admin/ai-config — 平台 AI 模型配置(管理后台):维护多套配置,启用开关决定进入用途路由候选(可多条同时启用)。
// 配置存 D1(ai_provider_configs),apiKey AES-GCM 加密落库;按用途路由取配置,无启用配置时回退环境变量。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · AI 配置' })

const toast = useToast()

interface AiConfigRow {
  id: string
  name: string
  format: string
  baseUrl: string
  model: string
  apiKeyHint: string
  active: boolean
  createdAt: number
  updatedAt: number
}
interface EffectiveConfig {
  source: 'db' | 'env'
  name: string | null
  model: string
  baseUrl: string
}
interface EnvConfigInfo {
  model: string
  baseUrl: string
  hasKey: boolean
}

const rows = ref<AiConfigRow[]>([])
const effective = ref<EffectiveConfig | null>(null)
const envInfo = ref<EnvConfigInfo | null>(null)
const loading = ref(true)

// ---- 用途模型路由:各用途(生成世界/对话)当前指向的配置行 id,null=跟随当前生效配置 ----
type AiPurpose = 'worldGen' | 'chat'
const routing = ref<Record<AiPurpose, string | null>>({ worldGen: null, chat: null })
const routingBusy = ref<AiPurpose | null>(null)

const PURPOSE_META: { key: AiPurpose, label: string, desc: string }[] = [
  { key: 'worldGen', label: '生成世界', desc: '世界观提取 / 一致性检查 / 成书 / 作者识别等生成流水线调用' },
  { key: 'chat', label: '对话', desc: '游玩回合叙事 / 选项 / 开场设计 / 欲望推演等对话调用' }
]

/** 路由下拉选项:启用中的配置 + 常驻的「环境变量(部署默认)」(未选择的用途跟随默认链:最早的启用配置 → env) */
const purposeItems = computed(() => [
  ...rows.value.filter(c => c.active).map(c => ({ label: `${c.name} · ${c.model}`, value: c.id })),
  { label: '环境变量(部署默认)', value: AI_ROUTE_ENV }
])

/** 当前启用中的配置(可多条;display 兜底取创建最早的一条,与服务端生效链一致) */
const activeRows = computed(() => rows.value.filter(c => c.active))
const activeRow = computed(() => activeRows.value[activeRows.value.length - 1] ?? null)

/** 路由显示值:未显式指定时显示默认链指向(最早的启用配置;无则环境变量) */
function routingDisplay(p: AiPurpose): string | undefined {
  return routing.value[p] ?? activeRow.value?.id ?? AI_ROUTE_ENV
}

/** 环境变量行被哪些用途路由指向(列表"使用中"徽标) */
const envBadges = computed(() => {
  const out: string[] = []
  if (routing.value.worldGen === AI_ROUTE_ENV) out.push('生成世界使用中')
  if (routing.value.chat === AI_ROUTE_ENV) out.push('对话使用中')
  return out
})

/** 该配置行被哪些用途路由指向(列表"使用中"徽标) */
function purposeBadges(c: AiConfigRow): string[] {
  const out: string[] = []
  if (routing.value.worldGen === c.id) out.push('生成世界使用中')
  if (routing.value.chat === c.id) out.push('对话使用中')
  return out
}

/** 切换用途指向的配置(切换即保存;服务端合并式保存,只传变更的用途) */
async function onRoutingChange(purpose: AiPurpose, value: unknown) {
  const id = typeof value === 'string' && value ? value : null
  if ((routing.value[purpose] ?? null) === id || routingBusy.value) return
  if ((routing.value[purpose] ?? null) === id || routingBusy.value) return
  routingBusy.value = purpose
  try {
    const res = await $fetch<{ routing: Record<AiPurpose, string | null> }>('/api/admin/ai-config/purpose-routing', {
      method: 'PUT',
      body: { [purpose]: id }
    })
    routing.value = res.routing
    toast.add({ title: '用途模型已切换', description: '后续该用途的平台 AI 请求将使用新指向的配置', color: 'success' })
  } catch (e) {
    toast.add({ title: '切换失败', description: errText(e), color: 'error' })
  } finally {
    routingBusy.value = null
  }
}

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ configs: AiConfigRow[], effective: EffectiveConfig, env: EnvConfigInfo, routing: Record<AiPurpose, string | null> }>('/api/admin/ai-config')
    rows.value = res.configs
    effective.value = res.effective
    envInfo.value = res.env
    routing.value = { worldGen: res.routing?.worldGen ?? null, chat: res.routing?.chat ?? null }
  } catch (e) {
    toast.add({ title: '加载配置失败', description: errText(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
})

function errText(e: unknown): string {
  if (e instanceof Error) {
    const data = (e as { data?: { statusMessage?: string } }).data
    return data?.statusMessage || e.message
  }
  return String(e)
}

function fmtLabel(format: string) {
  return aiFormatMeta(format as AiApiFormat).label
}

/** 格式下拉选项(脚本侧计算,避免模板内联 map 的隐式 any) */
const formatItems = computed(() => AI_API_FORMATS.map(f => ({ label: f.label, value: f.value })))

// ---- 新建 / 编辑 ----
const modalOpen = ref(false)
const keyShow = ref(false)
const modal = reactive({
  id: null as string | null,
  name: '',
  format: 'chat' as AiApiFormat,
  baseUrl: '',
  apiKey: '',
  model: ''
})
const modalBusy = ref(false)
const modalError = ref<string | null>(null)
const testResult = ref<string | null>(null)
const testBusy = ref(false)

function openCreate() {
  modal.id = null
  modal.name = ''
  modal.format = 'chat'
  modal.baseUrl = ''
  modal.apiKey = ''
  modal.model = ''
  modalError.value = null
  testResult.value = null
  keyShow.value = false
  modalOpen.value = true
}

function openEdit(c: AiConfigRow) {
  modal.id = c.id
  modal.name = c.name
  modal.format = c.format as AiApiFormat
  modal.baseUrl = c.baseUrl
  modal.apiKey = ''
  modal.model = c.model
  modalError.value = null
  testResult.value = null
  keyShow.value = false
  modalOpen.value = true
}

/** 切换 API 格式:地址为空时填入该格式的默认官方地址 */
function onFormatChange() {
  const meta = aiFormatMeta(modal.format)
  if (!modal.baseUrl.trim()) modal.baseUrl = meta.defaultBaseUrl
}

async function onTest() {
  testBusy.value = true
  testResult.value = null
  try {
    const res = await $fetch<{ ok: boolean, message: string }>('/api/admin/ai-config/test', {
      method: 'POST',
      body: {
        // 编辑时带 id:apiKey 留空则用已存 key 测试(服务端合并)
        id: modal.id ?? undefined,
        format: modal.format,
        baseUrl: modal.baseUrl,
        apiKey: modal.apiKey,
        model: modal.model
      }
    })
    testResult.value = res.message
  } catch (e) {
    testResult.value = errText(e)
  } finally {
    testBusy.value = false
  }
}

async function onSave() {
  modalBusy.value = true
  modalError.value = null
  try {
    if (modal.id) {
      await $fetch(`/api/admin/ai-config/${modal.id}`, {
        method: 'PUT',
        body: { name: modal.name, format: modal.format, baseUrl: modal.baseUrl, apiKey: modal.apiKey, model: modal.model }
      })
    } else {
      await $fetch('/api/admin/ai-config', {
        method: 'POST',
        body: { name: modal.name, format: modal.format, baseUrl: modal.baseUrl, apiKey: modal.apiKey, model: modal.model }
      })
    }
    toast.add({
      title: modal.id ? '配置已更新' : '配置已创建',
      description: modal.id ? undefined : (rows.value.length === 0 ? '首条配置已自动启用' : undefined),
      color: 'success'
    })
    modalOpen.value = false
    void load()
  } catch (e) {
    modalError.value = errText(e)
  } finally {
    modalBusy.value = false
  }
}

// ---- 启用/停用开关(可多行同时启用;启用 = 进入用途路由候选,不影响其他配置) ----
const switchBusy = ref<string | null>(null)

async function onToggle(c: AiConfigRow, enabled: boolean) {
  if (switchBusy.value) return
  switchBusy.value = c.id
  try {
    await $fetch(`/api/admin/ai-config/${c.id}/activate`, { method: 'PUT', body: { enabled } })
    toast.add({
      title: enabled ? `已启用「${c.name}」` : `已停用「${c.name}」`,
      description: enabled ? '该配置已进入用途模型路由的下拉候选' : undefined,
      color: 'success'
    })
    void load()
  } catch (e) {
    toast.add({ title: enabled ? '启用失败' : '停用失败', description: errText(e), color: 'error' })
  } finally {
    switchBusy.value = null
  }
}

// ---- 删除确认 ----
const deleteOpen = ref(false)
const deleteTarget = ref<AiConfigRow | null>(null)
const deleteBusy = ref(false)

function askDelete(c: AiConfigRow) {
  deleteTarget.value = c
  deleteOpen.value = true
}

async function onDelete() {
  if (!deleteTarget.value || deleteBusy.value) return
  deleteBusy.value = true
  try {
    const t = deleteTarget.value
    await $fetch(`/api/admin/ai-config/${t.id}`, { method: 'DELETE' })
    toast.add({
      title: `已删除「${t.name}」`,
      description: t.active ? '该配置已从路由候选中移除' : undefined,
      color: 'success'
    })
    deleteOpen.value = false
    void load()
  } catch (e) {
    toast.add({ title: '删除失败', description: errText(e), color: 'error' })
  } finally {
    deleteBusy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          AI 模型配置
        </h1>
        <p class="text-sm text-neutral-500">
          维护平台 AI 模型配置,可启用多套作为用途路由候选,按用途分别指定,即时生效无需重新部署
        </p>
      </div>
      <UButton
        icon="i-lucide-plus"
        color="primary"
        @click="openCreate"
      >
        新建配置
      </UButton>
    </div>

    <!-- 当前生效 -->
    <UCard class="mb-4">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p class="flex items-center gap-2 font-semibold">
          <UIcon
            name="i-lucide-activity"
            class="size-4 text-emerald-600"
          />
          当前生效
        </p>
        <template v-if="effective">
          <UBadge
            size="sm"
            color="success"
            variant="soft"
          >
            {{ effective.source === 'db' ? `库内配置 · ${effective.name ?? '未命名'}` : '环境变量兜底' }}
          </UBadge>
          <p class="text-sm text-neutral-600 dark:text-neutral-300">
            {{ effective.model }}
            <span class="text-neutral-400">@</span>
            {{ effective.baseUrl }}
          </p>
        </template>
        <p
          v-else
          class="text-sm text-neutral-500"
        >
          加载中…
        </p>
      </div>
      <UAlert
        v-if="effective?.source === 'env'"
        class="mt-3"
        color="warning"
        variant="soft"
        icon="i-lucide-triangle-alert"
        title="当前未启用任何后台配置"
        description="系统正在使用环境变量 AI_BASE_URL / AI_API_KEY / AI_MODEL。创建配置后即可由后台接管,无需修改部署。"
      />
    </UCard>

    <!-- 用途模型路由 -->
    <UCard class="mb-4">
      <div class="space-y-3">
        <div>
          <p class="flex items-center gap-2 font-semibold">
            <UIcon
              name="i-lucide-route"
              class="size-4 text-primary-500"
            />
            用途模型路由
          </p>
          <p class="text-xs text-neutral-500">
            为不同用途指定使用的配置;下拉列表仅展示启用中的配置,未选择的用途跟随当前生效配置。被路由使用的配置在下方禁用/删除时会被阻止。
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField
            v-for="p in PURPOSE_META"
            :key="p.key"
            :label="p.label"
            :description="p.desc"
          >
            <USelect
              :model-value="routingDisplay(p.key)"
              :items="purposeItems"
              value-key="value"
              :loading="routingBusy === p.key"
              :disabled="!activeRow"
              :placeholder="activeRow ? '请选择配置' : '未启用任何库内配置'"
              :aria-label="`选择${p.label}使用的配置`"
              class="w-full"
              @update:model-value="v => onRoutingChange(p.key, v)"
            />
          </UFormField>
        </div>
      </div>
    </UCard>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                名称
              </th>
              <th class="py-2 pr-3 font-medium">
                启用
              </th>
              <th class="py-2 pr-3 font-medium">
                格式
              </th>
              <th class="py-2 pr-3 font-medium">
                API 地址
              </th>
              <th class="py-2 pr-3 font-medium">
                模型
              </th>
              <th class="py-2 pr-3 font-medium">
                Key
              </th>
              <th class="py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td
                colspan="7"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="7"
                class="py-6 text-center text-neutral-500"
              >
                暂无配置,点击右上角「新建配置」添加第一条(将自动启用)
              </td>
            </tr>
            <tr
              v-for="c in rows"
              :key="c.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="py-2.5 pr-3">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ c.name }}</span>
                  <UBadge
                    v-if="c.active"
                    size="sm"
                    color="success"
                    variant="soft"
                  >
                    已启用
                  </UBadge>
                  <UBadge
                    v-for="b in purposeBadges(c)"
                    :key="b"
                    size="sm"
                    color="primary"
                    variant="soft"
                  >
                    {{ b }}
                  </UBadge>
                </div>
              </td>
              <td class="py-2.5 pr-3">
                <!-- 启用开关:启用 = 进入用途模型路由的下拉候选(可多条同时启用);被路由使用时服务端阻止停用 -->
                <USwitch
                  :model-value="c.active"
                  :loading="switchBusy === c.id"
                  :aria-label="c.active ? `停用「${c.name}」` : `启用「${c.name}」`"
                  @update:model-value="v => onToggle(c, v === true)"
                />
              </td>
              <td class="py-2.5 pr-3 text-neutral-600 dark:text-neutral-300">
                {{ fmtLabel(c.format) }}
              </td>
              <td class="max-w-64 truncate py-2.5 pr-3 font-mono text-xs text-neutral-500">
                {{ c.baseUrl }}
              </td>
              <td class="py-2.5 pr-3 font-mono text-xs">
                {{ c.model }}
              </td>
              <td class="py-2.5 pr-3 font-mono text-xs text-neutral-500">
                ••••{{ c.apiKeyHint }}
              </td>
              <td class="py-2.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="soft"
                    icon="i-lucide-pencil"
                    @click="openEdit(c)"
                  >
                    编辑
                  </UButton>
                  <UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash"
                    @click="askDelete(c)"
                  >
                    删除
                  </UButton>
                </div>
              </td>
            </tr>
            <!-- 环境变量(部署默认):常驻路由候选行,在上方「用途模型路由」中按用途单独指定 -->
            <tr
              v-if="!loading"
              class="border-b border-neutral-100 bg-neutral-50/60 last:border-0 dark:border-neutral-900 dark:bg-neutral-900/40"
            >
              <td class="py-2.5 pr-3">
                <div class="flex items-center gap-2">
                  <span class="font-medium">环境变量(部署默认)</span>
                  <UBadge
                    v-for="b in envBadges"
                    :key="b"
                    size="sm"
                    color="primary"
                    variant="soft"
                  >
                    {{ b }}
                  </UBadge>
                </div>
              </td>
              <td class="py-2.5 pr-3 text-xs text-neutral-400">
                常驻可用
              </td>
              <td class="py-2.5 pr-3 text-neutral-600 dark:text-neutral-300">
                Chat
              </td>
              <td class="max-w-64 truncate py-2.5 pr-3 font-mono text-xs text-neutral-500">
                {{ envInfo?.baseUrl || '—' }}
              </td>
              <td class="py-2.5 pr-3 font-mono text-xs">
                {{ envInfo?.model || '—' }}
              </td>
              <td class="py-2.5 pr-3 font-mono text-xs text-neutral-500">
                {{ envInfo?.hasKey ? '••••(部署注入,不可见)' : '未配置' }}
              </td>
              <td class="py-2.5 text-xs text-neutral-400">
                由 wrangler 部署配置管理
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- 新建 / 编辑弹窗 -->
    <UModal
      v-model:open="modalOpen"
      :title="modal.id ? '编辑配置' : '新建配置'"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            label="配置名称"
            required
            hint="随意起名,便于区分多套配置"
          >
            <UInput
              v-model="modal.name"
              placeholder="如:DeepSeek 主力 / Claude 备用"
              maxlength="30"
              class="w-full"
            />
          </UFormField>

          <UFormField label="API 格式">
            <USelect
              v-model="modal.format"
              :items="formatItems"
              value-key="value"
              class="w-full"
              @update:model-value="onFormatChange"
            />
            <p class="mt-1 text-xs text-neutral-500">
              {{ aiFormatMeta(modal.format).desc }}
            </p>
          </UFormField>

          <UFormField
            label="API 地址"
            required
          >
            <UInput
              v-model="modal.baseUrl"
              :placeholder="aiFormatMeta(modal.format).defaultBaseUrl"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="modal.id ? 'API Key(留空保持不变)' : 'API Key'"
            :required="!modal.id"
          >
            <UInput
              v-model="modal.apiKey"
              :type="keyShow ? 'text' : 'password'"
              :placeholder="modal.id ? '••••••••(不修改请留空)' : 'sk-...'"
              :ui="{ trailing: 'pe-1' }"
              class="w-full"
            >
              <template #trailing>
                <UButton
                  color="neutral"
                  variant="link"
                  size="sm"
                  :icon="keyShow ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="keyShow ? '隐藏 API Key' : '显示 API Key'"
                  :aria-pressed="keyShow"
                  @click="keyShow = !keyShow"
                />
              </template>
            </UInput>
          </UFormField>

          <UFormField
            label="模型名"
            required
          >
            <UInput
              v-model="modal.model"
              :placeholder="aiFormatMeta(modal.format).placeholderModel"
              class="w-full"
            />
          </UFormField>

          <UButton
            block
            icon="i-lucide-plug-zap"
            color="neutral"
            variant="outline"
            :loading="testBusy"
            @click="onTest"
          >
            测试连接
          </UButton>
          <p
            v-if="testResult"
            class="text-xs"
            :class="testResult.includes('成功') ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'"
          >
            {{ testResult }}
          </p>
          <p
            v-if="modalError"
            class="text-xs text-red-500"
          >
            {{ modalError }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="modalOpen = false"
          >
            取消
          </UButton>
          <UButton
            icon="i-lucide-check"
            :loading="modalBusy"
            @click="onSave"
          >
            保存
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 删除确认 -->
    <UModal
      v-model:open="deleteOpen"
      title="删除配置"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          {{ deleteTarget?.active
            ? `「${deleteTarget?.name}」当前已启用,删除后将从路由候选中移除。`
            : `确定删除配置「${deleteTarget?.name}」吗?删除后不可恢复。` }}
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="deleteOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-trash"
            :loading="deleteBusy"
            @click="onDelete"
          >
            删除
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
