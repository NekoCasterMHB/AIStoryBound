<script setup lang="ts">
// /profile — 个人中心:token 余额、加油包购买(微支付网关跳转)、购买记录、自建模型配置(加密存储)
// 模型配置:默认配置(平台配额)与自建配置二选一;自建配置可存多套命名配置(Chat Completions / Anthropic Messages / Responses),表单在模态框内填写
// 设置区按三类分页(UTabs):模型配置(自建模型 + 生成参数)/ 游玩偏好(成人模式、叙事温度、偏好场景、云端同步)/ 技能管理(商城技能开关)
import type { TabsItem } from '@nuxt/ui'
import { TOKEN_PACKAGES } from '#shared/quota-packages'
import type { TokenPackage } from '#shared/quota-packages'
import { AI_API_FORMATS, aiFormatMeta, AI_USER_CONFIG_LIMIT } from '#shared/ai-config'
import type { AiApiFormat } from '#shared/ai-config'
import { useAuthSession } from '../utils/auth-client'
import { isAdultModeEnabled, setAdultModeEnabled } from '../utils/adultMode'
import { loadScenePrefs, saveScenePrefs } from '../utils/scenePrefs'
import {
  loadNarrTemp, saveNarrTemp, narrTempTier,
  NARR_TEMP_MIN, NARR_TEMP_MAX, NARR_TEMP_STEP, NARR_TEMP_TIERS
} from '../utils/narrPrefs'
import { ensureAiConfigLoaded, getAiConfigStateSync, saveAiConfigState } from '../utils/aiConfigStore'
import type { LocalAiConfig } from '../utils/aiConfigStore'
import {
  DEFAULT_GEN_LIMITS, GEN_LIMIT_RANGE, loadGenLimits, resetGenLimits, saveGenLimits
} from '../utils/genSettings'
import type { GenLimits } from '../utils/genSettings'
import { DEFAULT_TOY_SETTINGS, isAdapterEnabled, toggleAdapterEnabled } from '#shared/toy'
import type { ToyAdapter, ToySettings } from '#shared/toy'
import { toyController } from '../toy/api'
import { listImportedAdapters, loadToySettings, saveToySettings, clearLegacyImportedAdapters } from '../toy/store'
import { loadAllAdapters, removeImportedAdapter, importAdapterFiles } from '../toy/runtime/adapter-loader'
import { loadNarrSpeed, saveNarrSpeed, clampNarrCps, NARR_SPEED_TIERS, NARR_SPEED_DEFAULT } from '../utils/narrSpeed'
import { loadReinjectInterval, saveReinjectInterval, REINJECT_INTERVAL_MIN, REINJECT_INTERVAL_MAX } from '../utils/reinjectPrefs'
import { loadNarrLength, saveNarrLength, NARR_LENGTH_MIN, NARR_LENGTH_MAX, NARR_LENGTH_STEP } from '../utils/narrLength'

useHead({ title: 'AI Word2World · 个人中心' })

/** 设置区分四类标签页:模型配置 / 游玩偏好 / 技能管理(商城下载技能开关)/ 功能插件(硬件联动插件) */
const profileTabs = ref<TabsItem[]>([
  { label: '模型设置', value: 'model', slot: 'model', icon: 'i-lucide-cpu' },
  { label: '技能管理', value: 'skills', slot: 'skills', icon: 'i-lucide-package' },
  { label: '功能插件', value: 'plugins', slot: 'plugins', icon: 'i-lucide-plug' }
])
// 支持 /profile?tab=skills 等直达指定页签(商城「已获取」跳转用)
const route = useRoute()
const activeTab = ref(
  typeof route.query.tab === 'string' && profileTabs.value.some(t => t.value === route.query.tab)
    ? route.query.tab
    : 'model'
)

const { data: session } = await useAuthSession()
const toast = useToast()

interface MeInfo {
  id: string
  name: string
  email: string
  aiTokenBalance: number
}
interface PurchaseRecord {
  id: string
  orderNo: string
  packageId: string
  packageName: string
  amount: number
  provider: string
  status: string
  paidAt: number | null
  createdAt: number
}

const me = ref<MeInfo | null>(null)
const loadError = ref<string | null>(null)

/** 充值开关(数据库配置,管理端可即时启停):true=维护中禁用 */
const paymentDisabled = ref(false)

async function fetchPaymentConfig() {
  paymentDisabled.value = await $fetch<{ paymentDisabled: boolean }>('/api/payment/config')
    .then(r => r.paymentDisabled)
    .catch(() => false)
}

async function loadMe() {
  me.value = await $fetch<MeInfo>('/api/profile/me').catch(() => null)
  if (!me.value) loadError.value = '加载个人资料失败'
}
onMounted(() => {
  void loadMe()
  void fetchPaymentConfig()
  void refreshOneTimePackStatus()
  detectPaymentResult()
  void loadOwnedPlugins()
  void loadAdapters()
})

// ---- 功能插件(创意工坊「功能插件」购买后在此显示) ----
interface OwnedPlugin {
  id: string
  name: string
  desc: string
  price: number
  icon: string | null
  owned: boolean
}
const ownedPlugins = ref<OwnedPlugin[]>([])
const configOpen = ref(false)
const configPluginId = ref('sosexy')

async function loadOwnedPlugins() {
  if (!session.value) {
    ownedPlugins.value = []
    return
  }
  ownedPlugins.value = await $fetch<OwnedPlugin[]>('/api/store/plugins')
    .then(list => list.filter(p => p.owned))
    .catch(() => [])
}

function openPluginConfig(id: string) {
  configPluginId.value = id
  configOpen.value = true
}

/** 该适配器是否正处于连接中(卡片右上角显示绿色「已连接」tag;多连接按槽位判断) */
function isConnectedTo(id: string): boolean {
  return !!toyController.slotOf(id)?.connected
}

// ---- 卡片右上角标签:未连接 → 打开自定义设备选择器;已连接 → 确认框断开 ----

const pickerOpen = ref(false)
const pickerId = ref('')
const pickerName = ref('')

function openQuickPicker(id: string, name: string) {
  pickerId.value = id
  pickerName.value = name
  pickerOpen.value = true
}

const tagAction = ref<{ id: string, name: string } | null>(null)
const tagBusy = ref(false)
const tagConfirmOpen = computed({
  get: () => tagAction.value != null,
  set: (v: boolean) => { if (!v) tagAction.value = null }
})

async function doTagAction() {
  const act = tagAction.value
  if (!act || tagBusy.value) return
  tagBusy.value = true
  try {
    // 只断开该插件对应连接(多连接下不影响其它已连接插件)
    await toyController.disconnect(act.id)
    toast.add({ title: '已断开', color: 'neutral' })
  } finally {
    tagBusy.value = false
    tagAction.value = null
  }
}

// ---- 适配器管理(内置 + 玩家导入,可多选启用;导入支持 manifest.json 多选或 zip) ----
const allAdapters = ref<ToyAdapter[]>([])
const importedAdapterIds = ref<string[]>([])
/** 玩家导入的适配器(本地实体,与已购插件同款卡片展示) */
const importedAdapters = computed(() => allAdapters.value.filter(a => importedAdapterIds.value.includes(a.manifest.id)))
const adapterSettings = ref<ToySettings>({ ...DEFAULT_TOY_SETTINGS })
const guideOpen = ref(false)
const testOpen = ref(false)
const importBusy = ref(false)
const importFileRef = ref<HTMLInputElement | null>(null)

async function loadAdapters() {
  adapterSettings.value = await loadToySettings()
  allAdapters.value = await loadAllAdapters()
  importedAdapterIds.value = (await listImportedAdapters()).map(r => r.id)
  // 放弃旧版兼容:清掉 IndexedDB 中旧格式的导入记录
  void clearLegacyImportedAdapters()
}

function toggleAdapter(a: ToyAdapter, on: boolean) {
  adapterSettings.value.enabledAdapters = toggleAdapterEnabled(adapterSettings.value, a.manifest.id, on)
  void saveToySettings(adapterSettings.value)
}

async function onRemoveAdapter(id: string) {
  if (toyController.slotOf(id)?.connected) {
    await toyController.disconnect(id)
  }
  await removeImportedAdapter(id)
  await loadAdapters()
  toast.add({ title: '适配器已删除', color: 'neutral' })
}

/** 导入适配器(manifest.json 多选 / adapter.js / zip 包);强制校验,失败 toast 缺项 */
async function onImportFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  if (!files.length || importBusy.value) return
  importBusy.value = true
  try {
    await importAdapterFiles(files)
    await loadAdapters()
    toast.add({ title: '导入成功', description: '插件已导入,可在下方卡片启用与配置', color: 'success' })
  } catch (err) {
    toast.add({ title: '导入失败', description: err instanceof Error ? err.message : String(err), color: 'error' })
  } finally {
    importBusy.value = false
  }
}

const balance = computed(() => me.value?.aiTokenBalance ?? 0)
const balanceText = computed(() => balance.value.toLocaleString())

// ---- 购买加油包 ----
const buyOpen = ref(false)
const selectedPkg = ref<TokenPackage | null>(null)
/** 已购过限购新人包(paid)后不再展示该卡片,由购买记录判断 */
const boughtOneTimePack = ref(false)
/** 30 分钟内待支付的新人包订单:存在时点支付走"继续支付"续付该单,避免撞服务端限购 400 */
const pendingOneTimeOrder = ref<PurchaseRecord | null>(null)
const newbiePkg = computed(() => !boughtOneTimePack.value ? (TOKEN_PACKAGES.find(p => p.oneTimeOnly) ?? null) : null)
const regularPackages = TOKEN_PACKAGES.filter(p => !p.oneTimeOnly)
const buyBusy = ref<'wxpay' | 'alipay' | null>(null)
const buyError = ref<string | null>(null)

/** 拉取购买记录,判断限购新人包状态:paid 隐藏卡片,pending(30 分钟内)改走继续支付 */
async function refreshOneTimePackStatus() {
  const purchases = await $fetch<PurchaseRecord[]>('/api/profile/purchases').catch(() => [])
  boughtOneTimePack.value = purchases.some(p => p.packageId === 'tokens_1m_once' && p.status === 'paid')
  pendingOneTimeOrder.value = purchases.find(p => p.packageId === 'tokens_1m_once' && canContinue(p)) ?? null
}

function openBuy() {
  selectedPkg.value = (newbiePkg.value ?? regularPackages[0]) ?? null
  buyError.value = null
  buyOpen.value = true
}

/** 动态创建隐藏 form POST 跳转网关收银台 */
function jumpToGateway(res: { action: string, params: Record<string, string> }) {
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
}

async function submitOrder(payType: 'wxpay' | 'alipay') {
  if (!selectedPkg.value || buyBusy.value) return
  buyBusy.value = payType
  buyError.value = null
  try {
    // 新人包存在 30 分钟内待支付订单:服务端限购校验会拒绝重复下单(400),直接续付该订单
    if (selectedPkg.value.id === newbiePkg.value?.id && pendingOneTimeOrder.value) {
      const res = await $fetch<{ action: string, params: Record<string, string> }>('/api/payment/continue', {
        method: 'POST',
        body: { orderNo: pendingOneTimeOrder.value.orderNo }
      })
      jumpToGateway(res)
      return
    }
    const res = await $fetch<{ action: string, params: Record<string, string> }>('/api/payment/create', {
      method: 'POST',
      body: { packageId: selectedPkg.value.id, payType }
    })
    jumpToGateway(res)
  } catch (e) {
    buyError.value = e instanceof Error ? e.message : String(e)
  } finally {
    buyBusy.value = null
  }
}

// ---- 支付结果确认 ----
// 网关支付完成会跳回 return_url(/profile)并带上全部回调参数(out_trade_no/trade_status 等)。
// 页面检测到这些参数后,以数据库订单状态为准(只有验签通过的回调才会写库)展示成功/失败。
interface PayResult {
  state: 'checking' | 'paid' | 'pending' | 'error'
  orderNo: string
  packageName?: string
  amountFen?: number
  msg?: string
}
const payResultOpen = ref(false)
const payResult = ref<PayResult | null>(null)
let payResultTimer: ReturnType<typeof setTimeout> | null = null

function detectPaymentResult() {
  const q = route.query
  const orderNo = typeof q.out_trade_no === 'string' ? q.out_trade_no : ''
  const tradeStatus = typeof q.trade_status === 'string' ? q.trade_status : ''
  // 网关回跳特征:带 out_trade_no 且 trade_status
  if (!orderNo || !('trade_status' in q)) return
  void confirmPayResult(orderNo, tradeStatus, 0)
}

async function confirmPayResult(orderNo: string, tradeStatus: string, attempt: number) {
  payResultOpen.value = true
  payResult.value = { state: 'checking', orderNo }
  let confirmed = false
  try {
    const res = await $fetch<{ status: string, packageName: string, amount: number }>(
      `/api/payment/result?orderNo=${encodeURIComponent(orderNo)}`
    )
    confirmed = true
    if (res.status === 'paid') {
      payResult.value = { state: 'paid', orderNo, packageName: res.packageName, amountFen: res.amount }
      void loadMe() // 刷新余额
      void refreshOneTimePackStatus() // 新人包已购则隐藏卡片
      return
    }
  } catch {
    // 订单不存在/未登录:按 URL 参数兜底提示
    payResult.value = {
      state: tradeStatus === 'TRADE_SUCCESS' ? 'error' : 'error',
      orderNo,
      msg: tradeStatus === 'TRADE_SUCCESS'
        ? '已收到支付成功通知,但暂未确认到账,可稍后在购买记录中查看'
        : `支付状态:${tradeStatus || '未知'},未确认到账`
    }
    return
  }
  if (!confirmed) return
  // pending:异步回调可能尚未到达,每 5 秒重查,最多 60 秒
  if (attempt >= 12) {
    payResult.value = {
      state: 'error',
      orderNo,
      msg: '支付已提交但暂未确认到账,请稍后在购买记录中查看;若长时间未到账,请联系客服并提供订单号'
    }
    return
  }
  payResult.value = { state: 'pending', orderNo, msg: '支付回调处理中,正在确认到账…' }
  payResultTimer = setTimeout(() => {
    void confirmPayResult(orderNo, tradeStatus, attempt + 1)
  }, 5000)
}

function closePayResult() {
  if (payResultTimer) {
    clearTimeout(payResultTimer)
    payResultTimer = null
  }
  payResultOpen.value = false
  payResult.value = null
  // 清理 URL 上的回调参数,避免刷新重复弹窗(保留 tab 直达参数)
  const router = useRouter()
  void router.replace({ query: activeTab.value === 'model' ? {} : { tab: activeTab.value } })
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

// ---- 继续支付(30 分钟内待支付订单) ----
const continueBusy = ref<string | null>(null)
const continueError = ref('')

/** 待支付且未超过 30 分钟(与后端 PENDING_ORDER_TTL_MS 一致) */
function canContinue(r: PurchaseRecord) {
  return r.status === 'pending' && Date.now() - r.createdAt <= 30 * 60 * 1000
}

async function continuePay(r: PurchaseRecord) {
  if (continueBusy.value) return
  continueBusy.value = r.orderNo
  continueError.value = ''
  try {
    const res = await $fetch<{ action: string, params: Record<string, string> }>('/api/payment/continue', {
      method: 'POST',
      body: { orderNo: r.orderNo }
    })
    jumpToGateway(res)
  } catch (e) {
    continueError.value = e instanceof Error ? e.message : String(e)
    void openHistory() // 刷新列表(超时订单会被标记为已关闭)
  } finally {
    continueBusy.value = null
  }
}

// ---- 兑换码 ----
const redeemOpen = ref(false)
const redeemCode = ref('')
const redeemBusy = ref(false)
const redeemMsg = ref<{ kind: 'ok' | 'error', text: string } | null>(null)

function openRedeem() {
  redeemCode.value = ''
  redeemMsg.value = null
  redeemOpen.value = true
}

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

// ---- 修改密码(better-auth changePassword:校验当前密码后更新,可撤销其它设备会话) ----
const pwOpen = ref(false)
const pwBusy = ref(false)
const pwError = ref('')
const pwForm = reactive({ current: '', next: '', confirm: '' })
const pwShow = reactive({ current: false, next: false })

function openChangePassword() {
  pwError.value = ''
  pwForm.current = ''
  pwForm.next = ''
  pwForm.confirm = ''
  pwOpen.value = true
}

function changePasswordError(code: string | undefined): string {
  const map: Record<string, string> = {
    INVALID_PASSWORD: '当前密码错误,请重新输入',
    PASSWORD_TOO_SHORT: '新密码至少 8 位',
    PASSWORD_TOO_LONG: '新密码过长',
    CREDENTIAL_ACCOUNT_NOT_FOUND: '该账号未设置密码,暂不支持修改'
  }
  return map[code ?? ''] || '修改失败,请稍后重试'
}

async function submitChangePassword() {
  pwError.value = ''
  if (!pwForm.current || !pwForm.next || !pwForm.confirm) {
    pwError.value = '请填写完整'
    return
  }
  if (pwForm.next.length < 8) {
    pwError.value = '新密码至少 8 位'
    return
  }
  if (pwForm.next !== pwForm.confirm) {
    pwError.value = '两次输入的新密码不一致'
    return
  }
  pwBusy.value = true
  try {
    const { error } = await authClient.changePassword({
      currentPassword: pwForm.current,
      newPassword: pwForm.next,
      revokeOtherSessions: true
    })
    if (error) {
      pwError.value = changePasswordError(error.code)
      return
    }
    toast.add({ title: '密码已修改', color: 'success' })
    pwOpen.value = false
  } catch {
    pwError.value = '网络异常,请稍后重试'
  } finally {
    pwBusy.value = false
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

/** 配置数量上限:前端 UI 与服务端验证记录(每用户滚动保留)共用同一常量 */
const aiAtLimit = computed(() => aiState.value.configs.length >= AI_USER_CONFIG_LIMIT)

/**
 * 已通过服务端测试的配置签名集(format|baseUrl|apiKey|model)。
 * 保存前强制测试、启用前检查签名(缺失则补测一次);服务端 ai/ai/chat 指纹准入以此为准。
 */
const aiVerifiedSigs = ref(new Set<string>())

function aiConfigSig(format: AiApiFormat, baseUrl: string, apiKey: string, model: string) {
  return [format, baseUrl.trim(), apiKey.trim(), model.trim()].join('|')
}

/** 调服务端测试连接;成功时把签名记入已验证集合 */
async function testAiConfig(format: AiApiFormat, baseUrl: string, apiKey: string, model: string): Promise<{ ok: boolean, message: string }> {
  try {
    const res = await $fetch<{ ok: boolean, message: string }>('/api/profile/ai-config/test', {
      method: 'POST',
      body: { format, baseUrl, apiKey, model }
    })
    if (res.ok) aiVerifiedSigs.value.add(aiConfigSig(format, baseUrl, apiKey, model))
    return res
  } catch (e) {
    return { ok: false, message: errText(e) }
  }
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
  model: ''
})
const aiModalBusy = ref(false)
const aiModalError = ref<string | null>(null)
const aiTestResult = ref<string | null>(null)
const aiTestBusy = ref(false)

function openAiModal() {
  if (aiAtLimit.value) {
    aiMsg.value = { kind: 'error', text: `最多可保存 ${AI_USER_CONFIG_LIMIT} 套配置,请先删除不再使用的配置` }
    return
  }
  aiModal.id = null
  aiModal.name = ''
  aiModal.format = 'chat'
  aiModal.baseUrl = ''
  aiModal.apiKey = ''
  aiModal.model = ''
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
    const res = await testAiConfig(aiModal.format, aiModal.baseUrl, effectiveModalKey(), aiModal.model)
    aiTestResult.value = res.message
  } finally {
    aiTestBusy.value = false
  }
}

/** 模态框内生效的 apiKey:留空表示沿用原配置的 key(编辑场景) */
function effectiveModalKey(): string {
  const existing = aiModal.id ? aiState.value.configs.find(c => c.id === aiModal.id) : undefined
  return aiModal.apiKey.trim() || existing?.apiKey || ''
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
      // 思考统一关闭:自建配置不提供开关,保存时固定 false
      thinking: false,
      // 编辑时保留原启用状态;新建/编辑都不自动切换为当前配置
      active: existing?.active
    }
    // 保存前强制测试连接:不通过的配置不允许保存(服务端指纹只对测试通过的配置留痕)
    const test = await testAiConfig(cfg.format, cfg.baseUrl, cfg.apiKey, cfg.model)
    if (!test.ok) {
      aiTestResult.value = test.message
      aiModalError.value = `连接测试未通过,已取消保存:${test.message}`
      return
    }
    if (existing) {
      aiState.value.configs = aiState.value.configs.map(c => (c.id === cfg.id ? cfg : c))
    } else {
      aiState.value.configs.push(cfg)
    }
    await persistAiConfig()
    aiMsg.value = {
      kind: 'ok',
      text: existing ? `已更新「${cfg.name}」` : `已保存「${cfg.name}」`
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
    // 启用自建配置前确保其已通过服务端测试(签名缺失则补测一次,失败中止)
    if (target !== 'default' && !aiVerifiedSigs.value.has(aiConfigSig(target.format, target.baseUrl, target.apiKey, target.model))) {
      const test = await testAiConfig(target.format, target.baseUrl, target.apiKey, target.model)
      if (!test.ok) {
        aiMsg.value = { kind: 'error', text: `「${target.name}」连接测试未通过,无法启用:${test.message}` }
        return
      }
    }
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

// ---- 生成参数(本地偏好):只保留分段相关;输出上限/超时由平台默认,生成时不读用户值 ----
const loadedLimits = loadGenLimits()
const genForm = reactive({
  unitMaxChars: loadedLimits.unitMaxChars,
  unitOverlapChars: loadedLimits.unitOverlapChars
})
const genMsg = ref<{ kind: 'ok' | 'error', text: string } | null>(null)

/** 数量字段说明里的当前值展示:跟随输入框实时变化,输入无效时留空(默认值由 placeholder 展示) */
function fmtCurrent(v: unknown): string {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n.toLocaleString() : ''
}

/** 单次输入上限的实时换算提示(显示在输入框下方,分两行):跟踪当前输入值,输入无效时第二行留空 */
const unitMaxHint = computed(() => {
  const v = Number(genForm.unitMaxChars)
  return {
    desc: '单次提取放进的正文量',
    value: Number.isFinite(v) && v > 0 ? `≈ ${(v / 1.7 / 1000).toFixed(1)}K tokens` : ''
  }
})

/** 表单各字段的校验顺序与文案(范围取自 GEN_LIMIT_RANGE) */
const LIMIT_FIELDS: { key: 'unitMaxChars' | 'unitOverlapChars', label: string, unit: string }[] = [
  { key: 'unitMaxChars', label: '单次输入上限', unit: '字符' },
  { key: 'unitOverlapChars', label: '单元切段重叠', unit: '字符(0=关闭)' }
]

async function resetGenForm() {
  const ok = await resetGenLimits()
  genForm.unitMaxChars = DEFAULT_GEN_LIMITS.unitMaxChars
  genForm.unitOverlapChars = DEFAULT_GEN_LIMITS.unitOverlapChars
  genMsg.value = ok
    ? { kind: 'ok', text: '已恢复默认' }
    : { kind: 'error', text: '恢复默认失败,请检查网络' }
}

async function submitGenLimits() {
  const next: GenLimits = { ...DEFAULT_GEN_LIMITS }
  for (const f of LIMIT_FIELDS) {
    const range = GEN_LIMIT_RANGE[f.key]
    const v = Math.round(genForm[f.key])
    if (!Number.isFinite(v) || v < range.min || v > range.max) {
      genMsg.value = { kind: 'error', text: `${f.label}需在 ${range.min.toLocaleString()} ~ ${range.max.toLocaleString()} ${f.unit}之间` }
      return
    }
    next[f.key] = v
  }
  const ok = await saveGenLimits(next)
  if (ok) {
    genForm.unitMaxChars = next.unitMaxChars
    genForm.unitOverlapChars = next.unitOverlapChars
    genMsg.value = { kind: 'ok', text: '已保存到本地,下次生成世界时生效' }
  } else {
    genMsg.value = { kind: 'error', text: '保存失败,请检查网络' }
  }
}

// ---- 云端同步(本地偏好):本地存档是否上云,默认关闭 ----

/** 成人模式(本地偏好,默认关闭):开启后游玩时成人内容出现频率大幅上升 */
const adultModeOn = ref(isAdultModeEnabled())
watch(adultModeOn, v => setAdultModeEnabled(v))

/** 游玩偏好场景(本地偏好):偏好/避免场景提示词,注入叙事,优先级低于系统规则 */
const scenePrefs = reactive(loadScenePrefs())
const sceneMsg = ref<{ kind: 'ok' | 'err', text: string } | null>(null)
function submitScenePrefs() {
  saveScenePrefs({ prefer: scenePrefs.prefer, avoid: scenePrefs.avoid })
  sceneMsg.value = { kind: 'ok', text: '已保存,新回合生效' }
}

/** 叙事温度(本地偏好,默认 1.2):回合正文生成的随机性档位,滑动条即时保存,新回合生效 */
const narrTemp = ref(loadNarrTemp())
const narrTempTierInfo = computed(() => narrTempTier(narrTemp.value))
watch(narrTemp, v => saveNarrTemp(v))

/** 叙事速度(IndexedDB 持久化):回合正文流式显示的速率档位,即时保存,新回合生效;支持自定义字符/秒 */
const narrSpeed = ref(NARR_SPEED_DEFAULT.cps)
const narrSpeedLoaded = ref(false)
void loadNarrSpeed().then((cps) => {
  narrSpeed.value = cps
  narrSpeedLoaded.value = true
})
const narrSpeedTierInfo = computed(() => NARR_SPEED_TIERS.find(t => t.cps === narrSpeed.value) ?? null)
watch(narrSpeed, (v) => {
  if (narrSpeedLoaded.value) void saveNarrSpeed(v)
})
/** 自定义速度输入(数字,回车/按钮应用;即时保存) */
const narrSpeedCustom = ref('')
function applyNarrSpeedCustom(): void {
  const n = Number(narrSpeedCustom.value)
  if (!Number.isFinite(n) || n <= 0) return
  narrSpeed.value = clampNarrCps(n)
  narrSpeedCustom.value = ''
}

/** 段回注间隔(本地偏好,默认 5 回合):每 N 回合重新注入当前段情节 + 段首原文窗口,即时保存,新回合生效 */
const reinjectEvery = ref(loadReinjectInterval())
watch(reinjectEvery, v => saveReinjectInterval(clampReinjectInterval(v)))

function clampReinjectInterval(v: number): number {
  if (!Number.isFinite(v)) return REINJECT_INTERVAL_MIN
  return Math.min(REINJECT_INTERVAL_MAX, Math.max(REINJECT_INTERVAL_MIN, Math.round(v)))
}

/** 每回合生成字数(本地偏好,默认 400 字):回合正文目标篇幅,滑动条即时保存,新回合生效 */
const narrLength = ref(loadNarrLength())
watch(narrLength, v => saveNarrLength(v))
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
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-key-round"
        @click="openChangePassword"
      >
        修改密码
      </UButton>
    </div>

    <UAlert
      v-if="loadError"
      color="error"
      variant="soft"
      :title="loadError"
    />

    <!-- 需求墙横幅 -->
    <NuxtLink
      to="/demand"
      class="mb-6 block overflow-hidden rounded-2xl border border-primary-500/25 bg-linear-to-br from-primary-500/10 via-transparent to-primary-400/10 px-5 py-4 transition-colors hover:border-primary-500/40 dark:border-primary-500/20 dark:from-primary-500/12 dark:to-primary-400/8"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="flex items-center gap-1.5 font-semibold text-highlighted">
            <UIcon
              name="i-lucide-message-square-plus"
              class="size-4 text-primary"
            />
            想让我们做什么?
          </p>
          <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            去需求墙提需求或点赞,高赞的会优先实现
          </p>
        </div>
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-arrow-right"
          trailing
        >
          去需求墙
        </UButton>
      </div>
    </NuxtLink>

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
        <div class="flex shrink-0 gap-2">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-receipt-text"
            @click="openHistory"
          >
            购买记录
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-ticket"
            @click="openRedeem"
          >
            兑换码
          </UButton>
        </div>
      </div>

      <UAlert
        v-if="paymentDisabled"
        color="warning"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="充值系统维护中"
        description="可私聊作者购买token,维护期间额外赠送30%, 以兑换码形式发放。"
        class="mt-5"
      />
      <UButton
        color="primary"
        icon="i-lucide-zap"
        size="lg"
        block
        class="mt-3"
        :disabled="paymentDisabled"
        @click="openBuy"
      >
        {{ paymentDisabled ? '购买加油包(维护中)' : '购买加油包' }}
      </UButton>
    </UCard>

    <!-- 兑换码模态框 -->
    <UModal
      v-model:open="redeemOpen"
      title="兑换码"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-neutral-500">
            输入活动兑换码,兑换的 token 将直接到账余额
          </p>
          <UInput
            v-model="redeemCode"
            placeholder="输入兑换码"
            size="lg"
            :disabled="redeemBusy"
            @keyup.enter="submitRedeem"
          />
          <UButton
            color="primary"
            block
            icon="i-lucide-ticket-check"
            :loading="redeemBusy"
            :disabled="!redeemCode.trim()"
            @click="submitRedeem"
          >
            兑换
          </UButton>
          <p
            v-if="redeemMsg"
            class="text-sm"
            :class="redeemMsg.kind === 'ok' ? 'text-emerald-600' : 'text-red-500'"
          >
            {{ redeemMsg.text }}
          </p>
        </div>
      </template>
    </UModal>

    <!-- 修改密码模态框 -->
    <UModal
      v-model:open="pwOpen"
      title="修改密码"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-neutral-500">
            修改成功后其它设备的登录会话将失效,需重新登录
          </p>
          <div>
            <p class="mb-1 text-sm font-medium">
              当前密码
            </p>
            <UInput
              v-model="pwForm.current"
              :type="pwShow.current ? 'text' : 'password'"
              placeholder="输入当前密码"
              :disabled="pwBusy"
              @keyup.enter="submitChangePassword"
            />
          </div>
          <div>
            <p class="mb-1 text-sm font-medium">
              新密码
            </p>
            <UInput
              v-model="pwForm.next"
              :type="pwShow.next ? 'text' : 'password'"
              placeholder="至少 8 位"
              :disabled="pwBusy"
              @keyup.enter="submitChangePassword"
            />
          </div>
          <div>
            <p class="mb-1 text-sm font-medium">
              确认新密码
            </p>
            <UInput
              v-model="pwForm.confirm"
              :type="pwShow.next ? 'text' : 'password'"
              placeholder="再输入一次"
              :disabled="pwBusy"
              @keyup.enter="submitChangePassword"
            />
          </div>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-eye"
            class="self-end"
            @click="pwShow.current = !pwShow.current; pwShow.next = !pwShow.next"
          >
            {{ pwShow.next ? '隐藏密码' : '显示密码' }}
          </UButton>
          <p
            v-if="pwError"
            class="text-sm text-red-500"
          >
            {{ pwError }}
          </p>
          <UButton
            color="primary"
            block
            icon="i-lucide-key-round"
            :loading="pwBusy"
            @click="submitChangePassword"
          >
            确认修改
          </UButton>
        </div>
      </template>
    </UModal>

    <UTabs
      v-model="activeTab"
      :items="profileTabs"
      variant="pill"
      color="primary"
    >
      <template #model>
        <div class="mt-4">
          <!-- 模型配置:默认(平台配额)/ 自建 -->
          <UCard class="mb-6">
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p class="font-semibold">
                  模型配置
                </p>
                <p class="text-xs text-neutral-500">
                  默认配置用平台密钥、按量扣 token;自建配置用你的 Key 不扣平台配额,最多保存 {{ AI_USER_CONFIG_LIMIT }} 套随时切换
                </p>
              </div>
              <UButton
                color="primary"
                variant="outline"
                icon="i-lucide-plus"
                :disabled="aiBusy || aiAtLimit"
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

          <!-- 生成参数:只保留分段(本地偏好);输出上限/超时走平台默认 -->
          <UCard class="mb-6">
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p class="font-semibold">
                  生成参数
                </p>
                <p class="text-xs text-neutral-500">
                  只控制正文怎么切段上传;输出上限与超时由平台默认,不再单独限制
                </p>
              </div>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-rotate-ccw"
                @click="resetGenForm"
              >
                恢复默认
              </UButton>
            </div>
            <div class="grid gap-x-4 gap-y-6 sm:grid-cols-2">
              <UFormField label="单次输入上限">
                <template #help>
                  <p class="text-xs text-neutral-500">
                    {{ unitMaxHint.desc }}
                  </p>
                  <p
                    v-if="unitMaxHint.value"
                    class="tabular-nums text-xs text-neutral-500"
                  >
                    {{ unitMaxHint.value }}
                  </p>
                </template>
                <UFieldGroup class="w-full">
                  <UInput
                    v-model.number="genForm.unitMaxChars"
                    type="number"
                    :min="GEN_LIMIT_RANGE.unitMaxChars.min"
                    :max="GEN_LIMIT_RANGE.unitMaxChars.max"
                    :step="GEN_LIMIT_RANGE.unitMaxChars.step"
                    :placeholder="String(DEFAULT_GEN_LIMITS.unitMaxChars)"
                    class="w-full"
                  />
                  <UButton
                    color="neutral"
                    variant="subtle"
                    label="字符"
                    aria-hidden="true"
                    tabindex="-1"
                    class="pointer-events-none select-none"
                  />
                </UFieldGroup>
              </UFormField>
              <UFormField
                label="单元切段重叠"
                :help="`长章切段时保留的重叠,减少边界遗漏;0=关闭;当前 ${fmtCurrent(genForm.unitOverlapChars)}`"
              >
                <UFieldGroup class="w-full">
                  <UInput
                    v-model.number="genForm.unitOverlapChars"
                    type="number"
                    :min="GEN_LIMIT_RANGE.unitOverlapChars.min"
                    :max="GEN_LIMIT_RANGE.unitOverlapChars.max"
                    :step="GEN_LIMIT_RANGE.unitOverlapChars.step"
                    :placeholder="String(DEFAULT_GEN_LIMITS.unitOverlapChars)"
                    class="w-full"
                  />
                  <UButton
                    color="neutral"
                    variant="subtle"
                    label="字符"
                    aria-hidden="true"
                    tabindex="-1"
                    class="pointer-events-none select-none"
                  />
                </UFieldGroup>
              </UFormField>
            </div>
            <div class="mt-4 flex items-center gap-3">
              <UButton
                color="primary"
                icon="i-lucide-save"
                @click="submitGenLimits"
              >
                保存
              </UButton>
              <p
                v-if="genMsg"
                class="text-xs"
                :class="genMsg.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'"
              >
                {{ genMsg.text }}
              </p>
            </div>
          </UCard>
        </div>

        <!-- 游玩偏好(原独立 tab,已并入设置) -->
        <div class="mt-4">
          <!-- 成人模式:游玩时成人内容频率开关(本地偏好,默认关闭) -->
          <UCard class="mb-6">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p class="font-semibold">
                  成人模式
                </p>
                <p class="text-xs text-neutral-500">
                  开启后,游玩时成人内容出现频率大幅上升,并明显偏向训诫、BDSM、打屁股、捆绑、强制等亚文化题材,按角色性欲强度档位推进;默认关闭,开启后对所有游戏生效,也可在选角页单独调整
                </p>
              </div>
              <USwitch v-model="adultModeOn" />
            </div>
          </UCard>

          <!-- 叙事温度:回合正文生成的随机性档位(滑动条即时保存,新回合生效) -->
          <UCard class="mb-6">
            <div class="mb-3 flex flex-col gap-1">
              <p class="font-semibold">
                叙事温度
              </p>
              <p class="text-xs text-neutral-500">
                控制回合正文的随机性与文风多样性,滑动即时保存,新回合生效;选项生成与状态结算同样随此温度变化
              </p>
            </div>
            <div class="space-y-3">
              <div class="flex items-center gap-4">
                <USlider
                  v-model="narrTemp"
                  :min="NARR_TEMP_MIN"
                  :max="NARR_TEMP_MAX"
                  :step="NARR_TEMP_STEP"
                  class="flex-1"
                />
                <span class="w-12 shrink-0 text-right font-mono text-sm text-neutral-700 dark:text-neutral-300">{{ narrTemp.toFixed(1) }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <UBadge
                  color="primary"
                  variant="soft"
                >
                  {{ narrTempTierInfo?.label ?? '自定义' }}
                </UBadge>
                <p class="text-xs text-neutral-500">
                  {{ narrTempTierInfo?.desc ?? '介于两档之间,效果随数值连续变化' }}
                </p>
              </div>
              <div class="space-y-1 text-xs text-neutral-400">
                <p
                  v-for="t in NARR_TEMP_TIERS"
                  :key="t.label"
                  :class="narrTempTierInfo?.label === t.label ? 'font-medium text-primary-600 dark:text-primary-400' : ''"
                >
                  {{ t.range[0].toFixed(1) }}~{{ t.range[1].toFixed(1) }} {{ t.label }}:{{ t.desc }}
                </p>
              </div>
            </div>
          </UCard>

          <!-- 叙事速度:回合正文流式显示的速率档位(IndexedDB 持久化,即时保存,新回合生效) -->
          <UCard class="mb-6">
            <div class="mb-3 flex flex-col gap-1">
              <p class="font-semibold">
                叙事速度
              </p>
              <p class="text-xs text-neutral-500">
                控制回合正文流式显示的快慢与停顿节奏(打字机效果),选择即时保存到本地(IndexedDB),新回合生效;点击流式正文可立即显示全文
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <UButton
                v-for="t in NARR_SPEED_TIERS"
                :key="t.cps"
                size="sm"
                variant="soft"
                :color="narrSpeed === t.cps ? 'primary' : 'neutral'"
                @click="narrSpeed = t.cps"
              >
                {{ t.label }}
              </UButton>
              <span class="text-xs text-neutral-500">
                当前 {{ narrSpeed }} 字符/秒
              </span>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <UInput
                v-model="narrSpeedCustom"
                type="number"
                :min="1"
                :max="200"
                size="sm"
                class="w-28"
                placeholder="自定义"
                @keyup.enter="applyNarrSpeedCustom"
              />
              <UButton
                size="sm"
                variant="soft"
                @click="applyNarrSpeedCustom"
              >
                自定义字/秒
              </UButton>
              <span class="text-xs text-neutral-500">
                1~200,回车或点击应用
              </span>
            </div>
            <div class="mt-2 space-y-1 text-xs text-neutral-400">
              <p
                v-for="t in NARR_SPEED_TIERS"
                :key="t.label"
                :class="narrSpeedTierInfo?.label === t.label ? 'font-medium text-primary-600 dark:text-primary-400' : ''"
              >
                {{ t.label }} {{ t.cps }} 字/秒:{{ t.desc }}
              </p>
            </div>
          </UCard>

          <!-- 每回合生成字数:回合正文(AI 剧情)目标篇幅(滑动条即时保存,新回合生效) -->
          <UCard class="mb-6">
            <div class="mb-3 flex flex-col gap-1">
              <p class="font-semibold">
                每回合生成字数
              </p>
              <p class="text-xs text-neutral-500">
                控制每回合 AI 生成的剧情正文篇幅,滑动即时保存,新回合生效;选项与状态结算不受影响
              </p>
            </div>
            <div class="flex items-center gap-4">
              <USlider
                v-model="narrLength"
                :min="NARR_LENGTH_MIN"
                :max="NARR_LENGTH_MAX"
                :step="NARR_LENGTH_STEP"
                class="flex-1"
              />
              <span class="w-16 shrink-0 text-right font-mono text-sm text-neutral-700 dark:text-neutral-300">{{ narrLength }} 字</span>
            </div>
          </UCard>

          <!-- 防跑偏频率(段回注间隔):定期把当前段落原著原文重新注入,防止剧情越写越偏 -->
          <UCard class="mb-6">
            <div class="mb-3 flex flex-col gap-1">
              <p class="font-semibold">
                防跑偏频率
              </p>
              <p class="text-xs text-neutral-500">
                AI 会越写越偏离原著。设置每隔几个回合把当前段落的原著原文重新对照一次,把剧情拉回正轨;数字越小越贴原文、消耗略增,默认 5 回合,新回合生效
              </p>
            </div>
            <div class="flex items-center gap-4">
              <USlider
                v-model="reinjectEvery"
                :min="REINJECT_INTERVAL_MIN"
                :max="REINJECT_INTERVAL_MAX"
                :step="1"
                class="flex-1"
              />
              <span class="w-24 shrink-0 text-right font-mono text-sm text-neutral-700 dark:text-neutral-300">每 {{ reinjectEvery }} 回合</span>
            </div>
          </UCard>

          <!-- 游玩偏好场景:用户自定义偏好/避免场景提示词(优先级低于系统规则) -->
          <UCard class="mb-6">
            <div class="mb-3 flex flex-col gap-1">
              <p class="font-semibold">
                游玩偏好场景
              </p>
              <p class="text-xs text-neutral-500">
                自定义叙事提示词:「偏好场景」会适度增加相关内容,「避免场景」尽量不出现。优先级低于系统规则,与系统规则/人物卡设置冲突时以系统规则为准;保存后新回合生效
              </p>
            </div>
            <div class="space-y-4">
              <UFormField
                label="偏好场景"
                description="例如:训诫、捆绑、主从支配、当众羞耻"
              >
                <UTextarea
                  v-model="scenePrefs.prefer"
                  :rows="3"
                  autoresize
                  placeholder="留空不生效,可填写多个场景,用逗号分隔"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="避免出现的场景"
                description="例如:流血、永久伤害、多人"
              >
                <UTextarea
                  v-model="scenePrefs.avoid"
                  :rows="3"
                  autoresize
                  placeholder="留空不生效,可填写多个场景,用逗号分隔"
                  class="w-full"
                />
              </UFormField>
            </div>
            <div class="mt-4 flex items-center gap-3">
              <UButton
                color="primary"
                icon="i-lucide-save"
                @click="submitScenePrefs"
              >
                保存偏好
              </UButton>
              <p
                v-if="sceneMsg"
                class="text-xs"
                :class="sceneMsg.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'"
              >
                {{ sceneMsg.text }}
              </p>
            </div>
          </UCard>

          <!-- 云端备份:书架「同步云端」整包备份(作品+游戏会话+存盘点),跨设备在书架「云端备份」恢复 -->
          <UCard class="mb-6">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="font-semibold">
                  云端备份
                </p>
                <p class="text-xs text-neutral-500">
                  在「书架 → 本地作品」卡片菜单点「同步云端」,即可把作品、游戏会话与存盘点整包备份到云端(需登录账号),可在其他设备从「书架 → 云端备份」恢复续玩
                </p>
              </div>
            </div>
          </UCard>
        </div>
      </template>

      <!-- 技能管理:商城下载技能的启用开关(独立组件,其他页面可复用) -->
      <template #skills>
        <div class="mt-4">
          <SkillManager />
        </div>
      </template>

      <!-- 功能插件:适配器管理(内置与导入同级) + 已购插件列表;「详细配置」弹出该适配器的设置与控制 -->
      <template #plugins>
        <div class="mt-4 space-y-3">
          <!-- 功能插件:已购插件与玩家导入的适配器,统一卡片形式;导入/接入文档在顶部工具栏 -->
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm text-neutral-500">
              已解锁插件与本地导入的适配器;未解锁的插件可到
              <NuxtLink
                to="/workshop?tab=plugins"
                class="text-primary underline"
              >创意工坊 → 功能插件</NuxtLink>
              解锁(限时免费中)。
            </p>
            <div class="flex gap-2">
              <UButton
                size="xs"
                color="primary"
                variant="soft"
                icon="i-lucide-flask-conical"
                @click="testOpen = true"
              >
                测试能力
              </UButton>
              <UButton
                size="xs"
                variant="soft"
                icon="i-lucide-book-open"
                @click="guideOpen = true"
              >
                制作指南
              </UButton>
              <UButton
                size="xs"
                color="primary"
                icon="i-lucide-upload"
                :loading="importBusy"
                @click="importFileRef?.click()"
              >
                导入适配器
              </UButton>
              <!-- 隐藏文件选择:manifest.json 多选 + adapter.js + zip 包 -->
              <input
                ref="importFileRef"
                type="file"
                accept=".json,.js,.zip"
                multiple
                class="hidden"
                @change="onImportFiles"
              >
            </div>
          </div>

          <!-- 已购插件卡片 -->
          <div
            v-if="ownedPlugins.length"
            class="grid gap-3 md:grid-cols-2"
          >
            <UCard
              v-for="p in ownedPlugins"
              :key="p.id"
              class="relative flex flex-col"
            >
              <UBadge
                v-if="isConnectedTo(p.id)"
                size="sm"
                color="success"
                variant="solid"
                class="absolute right-3 top-3 cursor-pointer transition hover:opacity-80"
                @click="tagAction = { id: p.id, name: p.name }"
              >
                已连接
              </UBadge>
              <UBadge
                v-else
                size="sm"
                color="neutral"
                variant="soft"
                class="absolute right-3 top-3 cursor-pointer transition hover:opacity-80"
                @click="openQuickPicker(p.id, p.name)"
              >
                未连接
              </UBadge>
              <div class="flex items-start gap-3">
                <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">
                  {{ p.icon ?? '🧩' }}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold">{{ p.name }}</span>
                    <UBadge
                      size="sm"
                      color="primary"
                      variant="soft"
                    >
                      已解锁
                    </UBadge>
                  </div>
                  <p class="mt-1 line-clamp-2 text-sm text-neutral-500">
                    {{ p.desc }}
                  </p>
                </div>
              </div>
              <div class="mt-3">
                <UButton
                  block
                  size="sm"
                  color="primary"
                  variant="soft"
                  icon="i-lucide-settings-2"
                  @click="openPluginConfig(p.id)"
                >
                  详细配置
                </UButton>
              </div>
            </UCard>
          </div>

          <!-- 玩家导入的适配器卡片(本地实体,与已购插件同级卡片) -->
          <div
            v-if="importedAdapters.length"
            class="grid gap-3 md:grid-cols-2"
          >
            <UCard
              v-for="a in importedAdapters"
              :key="a.manifest.id"
              class="relative flex flex-col"
            >
              <UBadge
                v-if="isConnectedTo(a.manifest.id)"
                size="sm"
                color="success"
                variant="solid"
                class="absolute right-3 top-3 cursor-pointer transition hover:opacity-80"
                @click="tagAction = { id: a.manifest.id, name: a.manifest.name }"
              >
                已连接
              </UBadge>
              <UBadge
                v-else
                size="sm"
                color="neutral"
                variant="soft"
                class="absolute right-3 top-3 cursor-pointer transition hover:opacity-80"
                @click="openQuickPicker(a.manifest.id, a.manifest.name)"
              >
                未连接
              </UBadge>
              <div class="flex items-start gap-3">
                <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">
                  🧩
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">{{ a.manifest.name }}</span>
                    <UBadge
                      size="xs"
                      variant="soft"
                    >
                      {{ a.manifest.protocol ? 'Tier 1 配置' : 'Tier 2 代码' }}
                    </UBadge>
                    <span class="text-xs text-neutral-400">v{{ a.manifest.version }}</span>
                  </div>
                  <p class="mt-1 line-clamp-2 text-sm text-neutral-500">
                    本地导入 · 功能:{{ (a.manifest.capabilities?.functions ?? []).map(f => f.name).join(' / ') || '无' }}
                  </p>
                </div>
              </div>
              <div class="mt-3 flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  <span class="text-xs text-neutral-500">启用</span>
                  <USwitch
                    size="sm"
                    :model-value="isAdapterEnabled(adapterSettings, a.manifest.id)"
                    @update:model-value="(v: boolean) => toggleAdapter(a, v)"
                  />
                </div>
                <div class="flex gap-2">
                  <UButton
                    size="sm"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    @click="onRemoveAdapter(a.manifest.id)"
                  >
                    删除
                  </UButton>
                  <UButton
                    size="sm"
                    color="primary"
                    variant="soft"
                    icon="i-lucide-settings-2"
                    @click="openPluginConfig(a.manifest.id)"
                  >
                    详细配置
                  </UButton>
                </div>
              </div>
            </UCard>
          </div>

          <div
            v-if="!ownedPlugins.length && !importedAdapters.length"
            class="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700"
          >
            还没有解锁任何功能插件或导入适配器
          </div>
        </div>
      </template>
    </UTabs>
    <!-- 功能插件详细配置弹窗(该适配器的设置 + 模拟/真机切换 + 手动控制) -->
    <ToyConfigModal
      v-model:open="configOpen"
      :plugin-id="configPluginId"
    />
    <!-- 功能插件能力测试(预制提示词暴露能力给 AI 逐个调用测试) -->
    <PluginTestModal v-model:open="testOpen" />
    <!-- 快捷连接自定义设备选择器(已授权设备列表 + 电量;新设备才走系统选择器) -->
    <ToyQuickConnectModal
      v-model:open="pickerOpen"
      :adapter-id="pickerId"
      :adapter-name="pickerName"
    />
    <!-- 配置制作指导文档弹窗(强制格式规范 + md/模板下载) -->
    <PluginGuideModal v-model:open="guideOpen" />
    <!-- 卡片标签断开确认框 -->
    <UModal
      v-model:open="tagConfirmOpen"
      title="断开连接"
    >
      <template #body>
        <p class="text-sm text-neutral-500">
          确认断开「{{ tagAction?.name }}」?
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            variant="soft"
            :disabled="tagBusy"
            @click="tagAction = null"
          >
            取消
          </UButton>
          <UButton
            color="primary"
            :loading="tagBusy"
            @click="doTagAction"
          >
            断开
          </UButton>
        </div>
      </template>
    </UModal>
    <!-- 购买弹窗 -->
    <UModal
      v-model:open="buyOpen"
      title="购买 Token 加油包"
      :ui="{ content: 'sm:max-w-2xl!' }"
    >
      <template #body>
        <div class="space-y-4">
          <UAlert
            v-if="paymentDisabled"
            color="warning"
            variant="soft"
            icon="i-lucide-circle-alert"
            title="充值系统维护中"
            description="可私聊作者购买,维护期间额外赠送 30% , token以兑换码形式发放。"
          />
          <p class="text-sm text-neutral-500">
            选择加油包套餐:
          </p>
          <div class="space-y-3">
            <!-- 新人限购包:独占整行,布局与常规套餐一致 -->
            <UCard
              v-if="newbiePkg"
              class="cursor-pointer border-2 transition"
              :class="selectedPkg?.id === newbiePkg.id ? 'border-primary-400' : 'border-transparent'"
              :ui="{ body: 'p-2 sm:p-3' }"
              @click="selectedPkg = newbiePkg"
            >
              <p class="flex items-center gap-1.5 font-semibold">
                {{ newbiePkg.label }}
                <UBadge
                  size="sm"
                  color="warning"
                  variant="soft"
                >
                  限购一次
                </UBadge>
              </p>
              <p class="text-xs text-neutral-500">
                {{ newbiePkg.description }}
                <br>
                {{ newbiePkg.description2 }}
              </p>
              <p class="mt-2 flex items-baseline gap-1.5">
                <span class="text-lg font-bold">¥{{ newbiePkg.priceYuan }}</span>
                <span
                  v-if="newbiePkg.originalPriceYuan"
                  class="text-xs text-neutral-400 line-through"
                >¥{{ newbiePkg.originalPriceYuan }}</span>
                <UBadge
                  v-if="newbiePkg.discountLabel"
                  size="sm"
                  color="error"
                  variant="soft"
                >
                  {{ newbiePkg.discountLabel }}
                </UBadge>
              </p>
              <p class="text-xs text-neutral-500">
                到账 {{ newbiePkg.tokens.toLocaleString() }} tokens
              </p>
              <p
                v-if="pendingOneTimeOrder"
                class="mt-1.5 flex items-center gap-1 text-xs font-medium text-amber-600"
              >
                <UIcon
                  name="i-lucide-circle-alert"
                  class="size-3.5 shrink-0"
                />
                有一笔待支付订单,点击支付将续付该订单
              </p>
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
            :disabled="paymentDisabled || buyBusy === 'alipay'"
            @click="submitOrder('wxpay')"
          >
            <UIcon
              name="i-simple-icons-wechat"
              class="size-5 shrink-0"
            />
            {{ paymentDisabled ? '微信支付(维护中)' : '微信支付' }}
          </UButton>
          <UButton
            block
            class="bg-[#1677FF]! text-white!"
            :loading="buyBusy === 'alipay'"
            :disabled="paymentDisabled || buyBusy === 'wxpay'"
            @click="submitOrder('alipay')"
          >
            <UIcon
              name="i-simple-icons-alipay"
              class="size-5 shrink-0"
            />
            {{ paymentDisabled ? '支付宝(维护中)' : '支付宝' }}
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

    <!-- 支付结果确认模态框(网关跳回时自动弹出) -->
    <UModal
      v-model:open="payResultOpen"
      :dismissible="payResult?.state === 'paid' || payResult?.state === 'error'"
      @update:open="v => { if (!v) closePayResult() }"
    >
      <template #body>
        <div
          v-if="payResult"
          class="flex flex-col items-center gap-3 py-4 text-center"
        >
          <template v-if="payResult.state === 'checking'">
            <UIcon
              name="i-lucide-loader-circle"
              class="size-12 animate-spin text-primary-500"
            />
            <p class="font-semibold">
              正在确认支付结果…
            </p>
            <p class="text-xs text-neutral-400">
              订单号 {{ payResult.orderNo }}
            </p>
          </template>
          <template v-else-if="payResult.state === 'paid'">
            <UIcon
              name="i-lucide-check-circle"
              class="size-12 text-emerald-500"
            />
            <p class="text-lg font-semibold">
              充值成功
            </p>
            <p
              v-if="payResult.packageName"
              class="text-sm text-neutral-500"
            >
              {{ payResult.packageName }} 已到账
            </p>
            <p class="text-xs text-neutral-400">
              订单号 {{ payResult.orderNo }}
            </p>
          </template>
          <template v-else-if="payResult.state === 'pending'">
            <UIcon
              name="i-lucide-loader-circle"
              class="size-12 animate-spin text-amber-500"
            />
            <p class="font-semibold">
              {{ payResult.msg }}
            </p>
            <p class="text-xs text-neutral-400">
              订单号 {{ payResult.orderNo }}
            </p>
          </template>
          <template v-else>
            <UIcon
              name="i-lucide-circle-alert"
              class="size-12 text-amber-500"
            />
            <p class="text-lg font-semibold">
              未确认到账
            </p>
            <p class="text-sm text-neutral-500">
              {{ payResult.msg }}
            </p>
            <p class="text-xs text-neutral-400">
              订单号 {{ payResult.orderNo }}
            </p>
          </template>
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

          <UButton
            block
            icon="i-lucide-plug-zap"
            color="neutral"
            variant="outline"
            :loading="aiTestBusy"
            @click="onAiTest"
          >
            测试连接
          </UButton>
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
      <template #footer>
        <UButton
          block
          icon="i-lucide-save"
          color="primary"
          :loading="aiModalBusy"
          @click="onAiSave"
        >
          保存
        </UButton>
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
              <UButton
                v-if="canContinue(r)"
                size="xs"
                color="primary"
                variant="soft"
                :loading="continueBusy === r.orderNo"
                @click="continuePay(r)"
              >
                继续支付
              </UButton>
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
          <p
            v-if="continueError"
            class="text-xs text-red-500"
          >
            {{ continueError }}
          </p>
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
