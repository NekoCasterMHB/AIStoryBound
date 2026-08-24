<script setup lang="ts">
// /profile — 个人中心:token 余额、加油包购买(微支付网关跳转)、购买记录、自建模型配置(加密存储)
// 模型配置:默认配置(平台配额)与自建配置二选一;自建配置可存多套命名配置(Chat Completions / Anthropic Messages / Responses),表单在模态框内填写
import { TOKEN_PACKAGES } from '#shared/quota-packages'
import type { TokenPackage } from '#shared/quota-packages'
import { AI_API_FORMATS, aiFormatMeta } from '#shared/ai-config'
import type { AiApiFormat } from '#shared/ai-config'
import { useAuthSession } from '../utils/auth-client'
import { ensureAiConfigLoaded, getAiConfigStateSync, saveAiConfigState } from '../utils/aiConfigStore'
import type { LocalAiConfig } from '../utils/aiConfigStore'

useHead({ title: 'AI StoryBound · 个人中心' })

const { data: session } = await useAuthSession()

interface MeInfo {
  id: string
  name: string
  email: string
  aiTokenBalance: number
}
interface PurchaseRecord {
  id: string
  orderNo: string
  packageName: string
  amount: number
  provider: string
  status: string
  paidAt: number | null
  createdAt: number
}

const me = ref<MeInfo | null>(null)
const loadError = ref<string | null>(null)

async function loadMe() {
  me.value = await $fetch<MeInfo>('/api/profile/me').catch(() => null)
  if (!me.value) loadError.value = '加载个人资料失败'
}
onMounted(() => {
  void loadMe()
})

const balance = computed(() => me.value?.aiTokenBalance ?? 0)
const balanceText = computed(() => balance.value.toLocaleString())

// ---- 购买加油包 ----
const buyOpen = ref(false)
const selectedPkg = ref<TokenPackage | null>(null)
const newbiePkg = TOKEN_PACKAGES.find(p => p.oneTimeOnly) ?? null
const regularPackages = TOKEN_PACKAGES.filter(p => !p.oneTimeOnly)
const buyBusy = ref<'wxpay' | 'alipay' | null>(null)
const buyError = ref<string | null>(null)

function openBuy() {
  selectedPkg.value = TOKEN_PACKAGES[0] ?? null
  buyError.value = null
  buyOpen.value = true
}

async function submitOrder(payType: 'wxpay' | 'alipay') {
  if (!selectedPkg.value || buyBusy.value) return
  buyBusy.value = payType
  buyError.value = null
  try {
    const res = await $fetch<{ action: string, params: Record<string, string> }>('/api/payment/create', {
      method: 'POST',
      body: { packageId: selectedPkg.value.id, payType }
    })
    // 动态创建隐藏 form POST 跳转网关收银台
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = res.action
    form.style.display = 'none'
    for (const [k, v] of Object.entries(res.params)) {
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = k
      input.value = v
      form.appendChild(input)
    }
    document.body.appendChild(form)
    form.submit()
  } catch (e) {
    buyError.value = e instanceof Error ? e.message : String(e)
  } finally {
    buyBusy.value = null
  }
}

// ---- 购买记录 ----
const historyOpen = ref(false)
const history = ref<PurchaseRecord[]>([])
const historyLoading = ref(false)

async function openHistory() {
  historyOpen.value = true
  historyLoading.value = true
  history.value = await $fetch<PurchaseRecord[]>('/api/profile/purchases').catch(() => [])
  historyLoading.value = false
  // 支付完成后网关跳回本页:刷新余额
  void loadMe()
}

function fmtAmount(amountFen: number) {
  return `¥${(amountFen / 100).toFixed(2)}`
}

function fmtTs(ts: number | null) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function statusLabel(s: string) {
  const map: Record<string, { text: string, color: 'success' | 'neutral' | 'error' }> = {
    paid: { text: '已支付', color: 'success' },
    pending: { text: '待支付', color: 'neutral' },
    closed: { text: '已关闭', color: 'neutral' },
    refunded: { text: '已退款', color: 'error' }
  }
  return map[s] ?? { text: s, color: 'neutral' }
}

// ---- 兑换码 ----
const redeemCode = ref('')
const redeemBusy = ref(false)
const redeemMsg = ref<{ kind: 'ok' | 'error', text: string } | null>(null)

async function submitRedeem() {
  const code = redeemCode.value.trim()
  if (!code || redeemBusy.value) return
  redeemBusy.value = true
  redeemMsg.value = null
  try {
    const res = await $fetch<{ ok: true, tokens: number }>('/api/redeem', {
      method: 'POST',
      body: { code }
    })
    redeemCode.value = ''
    redeemMsg.value = { kind: 'ok', text: `兑换成功,已到账 ${res.tokens.toLocaleString()} tokens` }
    void loadMe()
  } catch (e) {
    redeemMsg.value = { kind: 'error', text: errText(e) }
  } finally {
    redeemBusy.value = false
  }
}

// ---- 自建模型配置(浏览器本地加密存储,服务端不保存;调用时由 aiRelay 随请求临时带 key) ----
type AiConfigItem = LocalAiConfig

const aiState = ref<{ enabled: boolean, configs: AiConfigItem[] }>({ enabled: false, configs: [] })
const aiBusy = ref(false)
const aiMsg = ref<{ kind: 'ok' | 'error', text: string } | null>(null)

async function loadAiConfig() {
  await ensureAiConfigLoaded()
  aiState.value = { ...getAiConfigStateSync() }
}
onMounted(() => {
  void loadAiConfig()
})

async function persistAiConfig() {
  await saveAiConfigState({ enabled: aiState.value.enabled, configs: aiState.value.configs })
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const data = (e as { data?: { statusMessage?: string } }).data
    return data?.statusMessage || e.message
  }
  return String(e)
}

const aiMode = computed<'default' | 'custom'>(() => (aiState.value.enabled ? 'custom' : 'default'))

/** 当前自建配置是否处于使用中 */
function isConfigActive(c: AiConfigItem) {
  return aiMode.value === 'custom' && c.active === true
}

/** 切回默认配置(平台配额),返回是否成功 */
async function onUseDefault(): Promise<boolean> {
  if (aiBusy.value || aiMode.value === 'default') return false
  aiBusy.value = true
  aiMsg.value = null
  try {
    aiState.value.enabled = false
    await persistAiConfig()
    return true
  } catch (e) {
    aiMsg.value = { kind: 'error', text: errText(e) }
    return false
  } finally {
    aiBusy.value = false
  }
}

async function onAiActivate(c: AiConfigItem): Promise<boolean> {
  if (aiBusy.value || isConfigActive(c)) return false
  aiBusy.value = true
  aiMsg.value = null
  try {
    aiState.value.configs.forEach((x) => {
      x.active = x.id === c.id
    })
    aiState.value.enabled = true
    await persistAiConfig()
    return true
  } catch (e) {
    aiMsg.value = { kind: 'error', text: errText(e) }
    return false
  } finally {
    aiBusy.value = false
  }
}

// 新建/编辑模态框
const aiModalOpen = ref(false)
const aiKeyShow = ref(false)
const aiModal = reactive({
  id: null as string | null,
  name: '',
  format: 'chat' as AiApiFormat,
  baseUrl: '',
  apiKey: '',
  model: '',
  thinking: false
})
const aiModalBusy = ref(false)
const aiModalError = ref<string | null>(null)
const aiTestResult = ref<string | null>(null)
const aiTestBusy = ref(false)

function openAiModal() {
  aiModal.id = null
  aiModal.name = ''
  aiModal.format = 'chat'
  aiModal.baseUrl = ''
  aiModal.apiKey = ''
  aiModal.model = ''
  aiModal.thinking = false
  aiModalError.value = null
  aiTestResult.value = null
  aiKeyShow.value = false
  aiModalOpen.value = true
}

function openAiEdit(c: AiConfigItem) {
  aiModal.id = c.id
  aiModal.name = c.name
  aiModal.format = c.format
  aiModal.baseUrl = c.baseUrl
  aiModal.apiKey = c.apiKey
  aiModal.model = c.model
  aiModal.thinking = c.thinking
  aiModalError.value = null
  aiTestResult.value = null
  aiKeyShow.value = false
  aiModalOpen.value = true
}

/** 切换 API 格式:地址为空时填入该格式的默认官方地址 */
function onAiFormatChange() {
  const meta = aiFormatMeta(aiModal.format)
  if (!aiModal.baseUrl.trim()) aiModal.baseUrl = meta.defaultBaseUrl
}

async function onAiTest() {
  aiTestBusy.value = true
  aiTestResult.value = null
  try {
    const res = await $fetch<{ ok: boolean, message: string }>('/api/profile/ai-config/test', {
      method: 'POST',
      body: { format: aiModal.format, baseUrl: aiModal.baseUrl, apiKey: aiModal.apiKey, model: aiModal.model }
    })
    aiTestResult.value = res.message
  } catch (e) {
    aiTestResult.value = errText(e)
  } finally {
    aiTestBusy.value = false
  }
}

async function onAiSave() {
  aiModalBusy.value = true
  aiModalError.value = null
  try {
    const existing = aiModal.id ? aiState.value.configs.find(c => c.id === aiModal.id) : undefined
    const cfg: AiConfigItem = {
      id: existing?.id ?? crypto.randomUUID(),
      name: aiModal.name.trim() || '未命名',
      format: aiModal.format,
      baseUrl: aiModal.baseUrl.trim(),
      apiKey: aiModal.apiKey.trim() || existing?.apiKey || '',
      model: aiModal.model.trim(),
      thinking: aiModal.thinking
    }
    if (existing) {
      aiState.value.configs = aiState.value.configs.map(c => (c.id === cfg.id ? cfg : c))
    } else {
      aiState.value.configs.push(cfg)
    }
    aiState.value.configs.forEach((c) => {
      c.active = c.id === cfg.id
    })
    aiState.value.enabled = true
    await persistAiConfig()
    aiMsg.value = {
      kind: 'ok',
      text: existing ? `已更新「${cfg.name}」并设为当前` : `已保存「${cfg.name}」并设为当前`
    }
    aiModalOpen.value = false
  } catch (e) {
    aiModalError.value = errText(e)
  } finally {
    aiModalBusy.value = false
  }
}

// 删除确认
const aiDeleteOpen = ref(false)
const aiDeleteTarget = ref<AiConfigItem | null>(null)
const aiDeleteBusy = ref(false)

function askAiDelete(c: AiConfigItem) {
  aiDeleteTarget.value = c
  aiDeleteOpen.value = true
}

async function onAiDelete() {
  if (!aiDeleteTarget.value || aiDeleteBusy.value) return
  aiDeleteBusy.value = true
  try {
    const targetId = aiDeleteTarget.value.id
    aiState.value.configs = aiState.value.configs.filter(c => c.id !== targetId)
    if (aiState.value.configs.length === 0) aiState.value.enabled = false
    await persistAiConfig()
    aiDeleteOpen.value = false
    aiDeleteTarget.value = null
    aiMsg.value = { kind: 'ok', text: '配置已删除' }
  } catch (e) {
    aiMsg.value = { kind: 'error', text: errText(e) }
  } finally {
    aiDeleteBusy.value = false
  }
}

// 启用确认(切换当前使用配置;'default' 表示平台默认配置)
const aiEnableOpen = ref(false)
const aiEnableTarget = ref<AiConfigItem | 'default' | null>(null)
const aiEnableBusy = ref(false)

function askAiEnable(target: AiConfigItem | 'default') {
  aiEnableTarget.value = target
  aiEnableOpen.value = true
}

function isEnableLoading(c: AiConfigItem) {
  return aiEnableBusy.value && aiEnableTarget.value === c
}

function isDefaultEnableLoading() {
  return aiEnableBusy.value && aiEnableTarget.value === 'default'
}

async function onAiEnable() {
  const target = aiEnableTarget.value
  if (!target || aiEnableBusy.value) return
  aiEnableBusy.value = true
  try {
    const ok = target === 'default' ? await onUseDefault() : await onAiActivate(target)
    if (ok) {
      const label = target === 'default' ? '默认配置(平台配额)' : target.name
      aiMsg.value = { kind: 'ok', text: `已启用「${label}」` }
      aiEnableOpen.value = false
      aiEnableTarget.value = null
    }
  } finally {
    aiEnableBusy.value = false
  }
}

function aiFormatLabel(f: AiApiFormat) {
  return aiFormatMeta(f).label
}

</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-6">
    <div class="mb-6 flex items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          个人中心
        </h1>
        <p class="text-sm text-neutral-500">
          {{ me?.name || session?.user?.name || '—' }} · {{ me?.email || '' }}
        </p>
      </div>
    </div>

    <UAlert
      v-if="loadError"
      color="error"
      variant="soft"
      :title="loadError"
    />

    <!-- 余额与加油包 -->
    <UCard class="mb-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="text-sm text-neutral-500">
            平台 AI 配额余额
          </p>
          <p class="mt-1 text-3xl font-bold tabular-nums">
            {{ balanceText }} <span class="text-base font-normal text-neutral-400">tokens</span>
          </p>
          <p class="mt-1 text-xs text-neutral-500">
            生成世界与游戏回合按实际用量扣减;配置自己的 API Key 后不消耗本余额
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-receipt-text"
          class="shrink-0"
          @click="openHistory"
        >
          购买记录
        </UButton>
      </div>

      <UButton
        color="primary"
        icon="i-lucide-zap"
        size="lg"
        block
        class="mt-5"
        @click="openBuy"
      >
        购买加油包
      </UButton>

      <!-- 兑换码 -->
      <div class="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <div class="flex gap-2">
          <UInput
            v-model="redeemCode"
            placeholder="输入兑换码(活动赠送)"
            class="flex-1"
            :disabled="redeemBusy"
            @keyup.enter="submitRedeem"
          />
          <UButton
            color="neutral"
            variant="soft"
            icon="i-lucide-ticket"
            :loading="redeemBusy"
            :disabled="!redeemCode.trim()"
            @click="submitRedeem"
          >
            兑换
          </UButton>
        </div>
        <p
          v-if="redeemMsg"
          class="mt-2 text-xs"
          :class="redeemMsg.kind === 'ok' ? 'text-emerald-600' : 'text-red-500'"
        >
          {{ redeemMsg.text }}
        </p>
      </div>
    </UCard>

    <!-- 模型配置:默认(平台配额)/ 自建 -->
    <UCard class="mb-6">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="font-semibold">
            模型配置
          </p>
          <p class="text-xs text-neutral-500">
            默认配置用平台密钥、按量扣 token;自建配置用你的 Key 不扣平台配额,可保存多套随时切换
          </p>
        </div>
        <UButton
          color="primary"
          variant="outline"
          icon="i-lucide-plus"
          :disabled="aiBusy"
          @click="openAiModal"
        >
          新建配置
        </UButton>
      </div>

      <div class="mt-4 grid gap-2">
        <div
          v-for="c in aiState.configs"
          :key="c.id"
          class="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 transition-colors"
          :class="isConfigActive(c)
            ? 'cursor-default border-primary-400/70 bg-primary-500/10 dark:border-primary-500/70 dark:bg-primary-500/15'
            : 'border-neutral-200 dark:border-neutral-700'"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-medium">
                {{ c.name }}
              </p>
              <UBadge
                size="sm"
                color="neutral"
                variant="soft"
              >
                {{ c.model }}
              </UBadge>
              <UBadge
                v-if="isConfigActive(c)"
                size="sm"
                color="success"
                variant="soft"
              >
                使用中
              </UBadge>
            </div>
            <p class="mt-0.5 truncate text-xs text-neutral-500">
              {{ aiFormatLabel(c.format) }} · {{ c.baseUrl }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <UButton
              v-if="!isConfigActive(c)"
              size="xs"
              color="primary"
              variant="soft"
              icon="i-lucide-circle-check"
              :loading="isEnableLoading(c)"
              @click="askAiEnable(c)"
            >
              启用
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="subtle"
              icon="i-lucide-pencil"
              :aria-label="`编辑 ${c.name}`"
              @click="openAiEdit(c)"
            />
            <UButton
              size="xs"
              color="error"
              variant="subtle"
              icon="i-lucide-trash-2"
              :aria-label="`删除 ${c.name}`"
              @click="askAiDelete(c)"
            />
          </div>
        </div>

        <!-- 平台默认配置(不可编辑/删除;未使用时通过「启用」切回) -->
        <div
          class="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 transition-colors"
          :class="aiMode === 'default'
            ? 'cursor-default border-primary-400/70 bg-primary-500/10 dark:border-primary-500/70 dark:bg-primary-500/15'
            : 'border-neutral-200 dark:border-neutral-700'"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-medium">
                默认配置(平台配额)
              </p>
              <UBadge
                v-if="aiMode === 'default'"
                size="sm"
                color="success"
                variant="soft"
              >
                使用中
              </UBadge>
            </div>
            <p class="mt-0.5 truncate text-xs text-neutral-500">
              平台密钥 · 按实际用量扣 token 余额
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <UButton
              v-if="aiMode !== 'default'"
              size="xs"
              color="primary"
              variant="soft"
              icon="i-lucide-circle-check"
              :loading="isDefaultEnableLoading()"
              @click="askAiEnable('default')"
            >
              启用
            </UButton>
          </div>
        </div>

        <p
          v-if="aiMsg"
          class="text-xs"
          :class="aiMsg.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'"
        >
          {{ aiMsg.text }}
        </p>
      </div>
      <p
        v-if="aiMode === 'custom' && aiState.configs.length === 0"
        class="mt-4 text-sm text-neutral-500"
      >
        还没有自建配置,点击右上角「新建配置」添加。
      </p>
    </UCard>

    <!-- 购买弹窗 -->
    <UModal
      v-model:open="buyOpen"
      title="购买 Token 加油包"
      :ui="{ content: 'sm:max-w-2xl!' }"
    >
      <template #body>
        <div class="space-y-4">
          <p class="text-sm text-neutral-500">
            选择加油包套餐:
          </p>
          <div class="space-y-3">
            <!-- 新人限购包:独占整行 -->
            <UCard
              v-if="newbiePkg"
              class="cursor-pointer border-2 transition"
              :class="selectedPkg?.id === newbiePkg.id ? 'border-primary-400' : 'border-transparent'"
              :ui="{ body: 'p-3 sm:p-4' }"
              @click="selectedPkg = newbiePkg"
            >
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="flex items-center gap-1.5 font-semibold">
                    {{ newbiePkg.label }}
                    <UBadge
                      size="sm"
                      color="warning"
                      variant="soft"
                    >
                      限购一次
                    </UBadge>
                    <UBadge
                      v-if="newbiePkg.discountLabel"
                      size="sm"
                      color="error"
                      variant="soft"
                    >
                      {{ newbiePkg.discountLabel }}
                    </UBadge>
                  </p>
                  <p class="mt-1 text-xs text-neutral-500">
                    {{ newbiePkg.description }}
                    <br>
                    {{ newbiePkg.description2 }}
                  </p>
                </div>
                <div class="text-right">
                  <p class="flex items-baseline justify-end gap-1.5">
                    <span class="text-2xl font-bold">¥{{ newbiePkg.priceYuan }}</span>
                    <span
                      v-if="newbiePkg.originalPriceYuan"
                      class="text-xs text-neutral-400 line-through"
                    >¥{{ newbiePkg.originalPriceYuan }}</span>
                  </p>
                  <p class="text-xs text-neutral-500">
                    到账 {{ newbiePkg.tokens.toLocaleString() }} tokens
                  </p>
                </div>
              </div>
            </UCard>

            <!-- 常规加油包:三列 -->
            <div class="grid gap-3 sm:grid-cols-3">
              <UCard
                v-for="pkg in regularPackages"
                :key="pkg.id"
                class="cursor-pointer border-2 transition"
                :class="selectedPkg?.id === pkg.id ? 'border-primary-400' : 'border-transparent'"
                :ui="{ body: 'p-2 sm:p-3' }"
                @click="selectedPkg = pkg"
              >
                <p class="font-semibold">
                  {{ pkg.label }}
                </p>
                <p class="text-xs text-neutral-500">
                  {{ pkg.description }}
                  <br>
                  {{ pkg.description2 }}
                </p>
                <p class="mt-2 flex items-baseline gap-1.5">
                  <span class="text-lg font-bold">¥{{ pkg.priceYuan }}</span>
                  <span
                    v-if="pkg.originalPriceYuan"
                    class="text-xs text-neutral-400 line-through"
                  >¥{{ pkg.originalPriceYuan }}</span>
                  <UBadge
                    v-if="pkg.discountLabel"
                    size="sm"
                    color="error"
                    variant="soft"
                  >
                    {{ pkg.discountLabel }}
                  </UBadge>
                </p>
                <p class="text-xs text-neutral-500">
                  到账 {{ pkg.tokens.toLocaleString() }} tokens
                </p>
              </UCard>
            </div>
          </div>
          <p
            v-if="buyError"
            class="text-sm text-red-500"
          >
            {{ buyError }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="grid w-full grid-cols-2 gap-2">
          <UButton
            block
            class="bg-[#07C160]! text-white!"
            :loading="buyBusy === 'wxpay'"
            :disabled="!selectedPkg || buyBusy === 'alipay'"
            @click="submitOrder('wxpay')"
          >
            <UIcon
              name="i-simple-icons-wechat"
              class="size-5 shrink-0"
            />
            微信支付
          </UButton>
          <UButton
            block
            class="bg-[#1677FF]! text-white!"
            :loading="buyBusy === 'alipay'"
            :disabled="!selectedPkg || buyBusy === 'wxpay'"
            @click="submitOrder('alipay')"
          >
            <UIcon
              name="i-simple-icons-alipay"
              class="size-5 shrink-0"
            />
            支付宝
          </UButton>
          <p class="col-span-2 text-left text-xs leading-loose text-neutral-500">
            * 充值 token 不支持退款
            <br>
            * 支付完成后自动跳回本页,配额实时到账
            <br>
            * 如未到账请查看购买记录。
          </p>
        </div>
      </template>
    </UModal>

    <!-- 新建/编辑模型配置弹窗 -->
    <UModal
      v-model:open="aiModalOpen"
      :title="aiModal.id ? '编辑模型配置' : '新建模型配置'"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            label="配置名称"
            required
            hint="随意起名,便于区分多套配置"
          >
            <UInput
              v-model="aiModal.name"
              placeholder="如:DeepSeek 主力 / Claude 备用"
              maxlength="30"
              class="w-full"
            />
          </UFormField>

          <UFormField label="API 格式">
            <USelect
              v-model="aiModal.format"
              :items="AI_API_FORMATS.map(f => ({ label: f.label, value: f.value }))"
              value-key="value"
              class="w-full"
              @update:model-value="onAiFormatChange"
            />
            <p class="mt-1 text-xs text-neutral-500">
              {{ aiFormatMeta(aiModal.format).desc }}
            </p>
          </UFormField>

          <UFormField
            label="API 地址"
            required
          >
            <UInput
              v-model="aiModal.baseUrl"
              :placeholder="aiFormatMeta(aiModal.format).defaultBaseUrl"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="aiModal.id ? 'API Key(留空保持不变)' : 'API Key'"
            :required="!aiModal.id"
          >
            <UInput
              v-model="aiModal.apiKey"
              :type="aiKeyShow ? 'text' : 'password'"
              :placeholder="aiModal.id ? '••••••••(不修改请留空)' : 'sk-...'"
              :ui="{ trailing: 'pe-1' }"
              class="w-full"
            >
              <template #trailing>
                <UButton
                  color="neutral"
                  variant="link"
                  size="sm"
                  :icon="aiKeyShow ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="aiKeyShow ? '隐藏 API Key' : '显示 API Key'"
                  :aria-pressed="aiKeyShow"
                  @click="aiKeyShow = !aiKeyShow"
                />
              </template>
            </UInput>
          </UFormField>

          <UFormField
            label="模型名"
            required
          >
            <UInput
              v-model="aiModal.model"
              :placeholder="aiFormatMeta(aiModal.format).placeholderModel"
              class="w-full"
            />
          </UFormField>

          <UFormField
            v-if="aiFormatMeta(aiModal.format).supportsThinking"
            label="请求模式"
          >
            <USelect
              v-model="aiModal.thinking"
              :items="[{ label: '思考关闭(快/省)', value: false }, { label: '思考开启(深度推理)', value: true }]"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <div class="flex gap-2">
            <UButton
              block
              color="primary"
              :loading="aiModalBusy"
              @click="onAiSave"
            >
              保存并设为当前
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              :loading="aiTestBusy"
              @click="onAiTest"
            >
              测试连接
            </UButton>
          </div>
          <p
            v-if="aiTestResult"
            class="text-xs"
            :class="aiTestResult.includes('成功') ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'"
          >
            {{ aiTestResult }}
          </p>
          <p
            v-if="aiModalError"
            class="text-xs text-red-500"
          >
            {{ aiModalError }}
          </p>
        </div>
      </template>
    </UModal>

    <!-- 启用配置确认弹窗 -->
    <UModal
      v-model:open="aiEnableOpen"
      title="启用配置"
    >
      <template #body>
        <p class="text-sm">
          <template v-if="aiEnableTarget === 'default'">
            确定启用「默认配置(平台配额)」?
            <br>
            启用后使用平台密钥,按实际用量扣 token 余额。
          </template>
          <template v-else-if="aiEnableTarget">
            确定启用「{{ aiEnableTarget.name }}」?
            <br>
            启用后生成与游戏将使用该配置的 Key 计费,不再消耗平台余额。
          </template>
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="aiEnableOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="primary"
            :loading="aiEnableBusy"
            @click="onAiEnable"
          >
            启用
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 删除配置确认弹窗 -->
    <UModal
      v-model:open="aiDeleteOpen"
      title="删除配置"
    >
      <template #body>
        <p class="text-sm">
          {{ aiDeleteTarget ? `确定删除「${aiDeleteTarget.name}」?删除后需要重新填写 API Key 才能恢复。` : '' }}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="aiDeleteOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="error"
            :loading="aiDeleteBusy"
            @click="onAiDelete"
          >
            删除
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 购买记录弹窗 -->
    <UModal
      v-model:open="historyOpen"
      title="购买记录"
    >
      <template #body>
        <div class="space-y-2">
          <p
            v-if="historyLoading"
            class="py-4 text-center text-sm text-neutral-500"
          >
            加载中…
          </p>
          <p
            v-else-if="history.length === 0"
            class="py-4 text-center text-sm text-neutral-500"
          >
            暂无购买记录
          </p>
          <div
            v-for="r in history"
            :key="r.id"
            class="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700"
          >
            <div class="min-w-0">
              <p class="truncate font-medium">
                {{ r.packageName }}
              </p>
              <p class="text-xs text-neutral-500">
                {{ r.orderNo }} · {{ fmtTs(r.createdAt) }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <UBadge
                :color="statusLabel(r.status).color"
                variant="soft"
                size="sm"
              >
                {{ statusLabel(r.status).text }}
              </UBadge>
              <span class="tabular-nums text-neutral-500">{{ fmtAmount(r.amount) }}</span>
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style>
/* 隐藏 Edge 原生密码可见切换(与自定义小眼睛重复) */
::-ms-reveal {
  display: none;
}
</style>
