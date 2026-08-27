<script setup lang="ts">
// ToyConfigModal.vue — 单个适配器的「详细配置」弹窗(由个人中心 → 功能插件 的适配器列表打开)。
// 只负责该适配器的配置与控制:安全设置、连接、手动控制(纵向滑块,拖动即发,0 即停,倒计时自动归零)。
// 适配器导入/删除/启用管理在个人中心 → 功能插件 tab(所有适配器同级,啵啵贝也是其中之一)。
import { reactive } from 'vue'
import { DEFAULT_TOY_SETTINGS, functionLimitOf, isAiFunctionEnabled, toggleAiFunctionEnabled } from '#shared/toy'
import type { ToyAdapter, ToyFunctionLimit, ToySettings, TrainPattern } from '#shared/toy'
import { toyController, toyFnStatus } from '../toy/api'
import { loadToySettings, saveToySettings } from '../toy/store'
import { mockTransport, mockTransportState } from '../toy/transports/mock'
import { webBluetoothTransport } from '../toy/transports/web-bluetooth'
import type { ToyTransportDevice } from '../toy/transports/transport'
import { loadAllAdapters } from '../toy/runtime/adapter-loader'

const props = defineProps<{ open: boolean, pluginId: string }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const toast = useToast()

/** 档位(切换式,不用输入框) */
const DURATION_TIERS = [
  { label: '60s', value: 60 },
  { label: '180s', value: 180 },
  { label: '300s', value: 300 },
  { label: '不限', value: 0 }
] as const
/** 调教形态选择器(全随机 = 每 8-15s 自动轮换到随机形态,参数也随机) */
const TRAIN_PATTERN_OPTIONS: { id: TrainPattern, label: string }[] = [
  { id: 'sine', label: '正弦' },
  { id: 'pulse', label: '脉冲' },
  { id: 'sawtooth', label: '锯齿' },
  { id: 'heartbeat', label: '心跳' },
  { id: 'random', label: '漫步' },
  { id: 'constant', label: '恒定' },
  { id: 'auto', label: '全随机' }
]
/** 弹窗内 tab:配置(安全设置/连接)与手动控制(纵向滑块) */
const modalTab = ref<'config' | 'control'>('config')

const settings = ref<ToySettings>({ ...DEFAULT_TOY_SETTINGS })
/** 本弹窗锁定的适配器(pluginId 定位;未导入时提示去功能插件页导入) */
const adapter = ref<ToyAdapter | null>(null)
const capabilities = computed(() => adapter.value?.manifest.capabilities?.functions ?? [])
/** 模拟/真机切换开关:开 = 真实蓝牙直连,关 = 模拟设备 */
const realBle = ref(false)
const connecting = ref(false)
/** 控制档位草稿:每个功能一条(模式/时长;强度由纵向滑块直接驱动) */
const draft = reactive<Record<string, { mode: number, duration: number }>>({})

const transport = computed(() => (realBle.value ? webBluetoothTransport : mockTransport))
const mockLog = computed(() => mockTransportState.writeLog.slice(-3).join('\n'))

function draftOf(fnId: string): { mode: number, duration: number } {
  return draft[fnId] ??= { mode: 1, duration: 60 }
}

// ---- 按能力单独的限制(未单独设置的字段回落全局默认) ----

function fnLimitOf(fnId: string): { maxIntensity: number } {
  return functionLimitOf(settings.value, fnId)
}

function setFnLimit(fnId: string, patch: Partial<ToyFunctionLimit>) {
  settings.value.functionLimits = {
    ...(settings.value.functionLimits ?? {}),
    [fnId]: { ...(settings.value.functionLimits?.[fnId] ?? {}), ...patch }
  }
}

/** 打开时载入设置并定位本弹窗对应的适配器;设置变更即时落盘 */
watch(() => props.open, async (open) => {
  if (!open) return
  settings.value = await loadToySettings()
  const all = await loadAllAdapters()
  adapter.value = all.find(a => a.manifest.id === props.pluginId) ?? null
  modalTab.value = 'config'
}, { immediate: true })

watch(settings, (s) => {
  void saveToySettings(s)
}, { deep: true })

// ---- 连接 ----

/** 连接状态:模拟测试(开关关)/ 真实蓝牙 二选一,以实际连接的 transport 为准 */
const connectedMock = computed(() => toyController.state.connected && toyController.state.transportId === 'mock')
const connectedBadge = computed(() => {
  if (!toyController.state.connected) return realBle.value ? '未连接' : '未连接 · 模拟模式'
  return connectedMock.value ? `模拟测试 · ${toyController.state.deviceName}` : `已连接 · ${toyController.state.deviceName}`
})

/** 已授权设备(Web Bluetooth getDevices,免系统选择器;仅含此前用户授权过的设备,点击即直连) */
const knownDevices = ref<ToyTransportDevice[]>([])
async function loadKnownDevices() {
  knownDevices.value = (await transport.value.listKnownDevices?.()) ?? []
}
// 打开弹窗/切到真机时刷新已授权设备列表
watch(realBle, (on) => {
  if (on) void loadKnownDevices()
})

async function doConnect(device?: ToyTransportDevice) {
  if (!adapter.value || connecting.value || toyController.state.connected) return
  connecting.value = true
  try {
    const res = await toyController.connect(adapter.value, transport.value, device ? { device } : {})
    if (!res.ok) {
      toast.add({ title: '连接失败', description: res.reason, color: 'error' })
      return
    }
    // 真机通过系统选择器连上后刷新列表,下次可免选择器直连
    void loadKnownDevices()
    if (connectedMock.value) {
      toast.add({ title: '模拟测试已连接', description: '当前为模拟设备,不会控制真实硬件;打开「真实蓝牙连接」开关即可连真机', color: 'success' })
    } else {
      toast.add({ title: '已连接', description: `${adapter.value.manifest.name} · ${toyController.state.deviceName}`, color: 'success' })
    }
  } finally {
    connecting.value = false
  }
}

async function doDisconnect() {
  await toyController.disconnect()
  toast.add({ title: '已断开', color: 'neutral' })
}

// ---- 手动控制:纵向滑块,进度变化即发,0 即停,倒计时结束自动归零 ----

/** 滑块当前值(用户拖动中;与设备实际状态同步,倒计时结束/外部停止自动归零;调教中显示实时调教值) */
const sliderVal = reactive<Record<string, number>>({})
/** 节流:拖动过程 150ms 内只发最后一次 */
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>()

function sliderValueOf(fnId: string): number {
  // 调教模式:滑块只读,显示当前调教强度
  if (toyController.isWaveActive(fnId)) {
    return toyController.state.functions[fnId]?.intensity ?? 0
  }
  return sliderVal[fnId] ?? toyController.state.functions[fnId]?.intensity ?? 0
}

/** 调教模式开关:按所选形态运行(正弦/脉冲/锯齿/心跳/漫步/恒定/全随机);启动时覆盖手动发送 */
const draftPattern = reactive<Record<string, TrainPattern>>({})

function patternOf(fnId: string): TrainPattern {
  return draftPattern[fnId] ??= 'random'
}

/** 切换形态:未在运行只改草稿;运行中直接以新形态重启(不停顿、不发停止帧) */
function selectPattern(fnId: string, p: TrainPattern) {
  draftPattern[fnId] = p
  if (toyController.isWaveActive(fnId)) {
    void toyController.startWave(fnId, [10, 100], { pattern: p, settings: settings.value })
  }
}

function toggleWave(fnId: string) {
  if (toyController.isWaveActive(fnId)) {
    toyController.stopWave(fnId)
    sliderVal[fnId] = toyController.state.functions[fnId]?.intensity ?? 0
    return
  }
  void toyController.startWave(fnId, [10, 100], { pattern: patternOf(fnId), settings: settings.value })
}

function onSliderInput(fnId: string, v: number) {
  sliderVal[fnId] = v
  const old = sendTimers.get(fnId)
  if (old) clearTimeout(old)
  sendTimers.set(fnId, setTimeout(() => {
    sendTimers.delete(fnId)
    void sendIntensity(fnId, sliderVal[fnId] ?? 0)
  }, 150))
}

/** 发送当前滑块值:强度 0 = 停止帧 */
async function sendIntensity(fnId: string, v: number) {
  const fn = capabilities.value.find(f => f.id === fnId)
  const res = await toyController.execute({
    function: fnId,
    intensity: v,
    ...(fn?.supportsMode ? { mode: draftOf(fnId).mode } : {}),
    ...(draftOf(fnId).duration > 0 ? { duration: draftOf(fnId).duration } : {})
  }, { source: 'manual', settings: settings.value })
  if (!res.ok) {
    // 发送失败回弹到设备实际状态
    sliderVal[fnId] = toyController.state.functions[fnId]?.intensity ?? 0
    toast.add({ title: '指令被拒绝', description: res.reason, color: 'error' })
  }
}

/** 设备状态变化(倒计时结束自动归零/紧急停止/外部停止)→ 滑块跟随;用户拖动中(pending 未发)不打断 */
watch(() => toyController.state.functions, (fns) => {
  for (const [id, st] of Object.entries(fns)) {
    if (sendTimers.has(id)) continue
    if (sliderVal[id] !== undefined && sliderVal[id] !== st.intensity) {
      sliderVal[id] = st.intensity
    }
  }
}, { deep: true })

// ---- 实时状态展示(每秒刷新,倒计时自动停止剩余秒数) ----

const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

/** 功能状态:运行中(有倒计时)/ 停止 */
function fnStatus(fnId: string): { running: boolean, remainingSec: number } {
  const s = toyFnStatus(fnId, nowTick.value)
  return { running: s.remainingSec > 0, remainingSec: s.remainingSec }
}

/** 手动控制 tab 各功能状态(每秒刷新) */
const fnStates = computed(() => {
  const out: Record<string, { running: boolean, remainingSec: number }> = {}
  for (const fn of capabilities.value) out[fn.id] = fnStatus(fn.id)
  return out
})

function fnStateOf(fnId: string): { running: boolean, remainingSec: number } {
  return fnStates.value[fnId] ?? { running: false, remainingSec: 0 }
}
</script>

<template>
  <UModal
    :open="props.open"
    :ui="{ content: 'sm:max-w-2xl!' }"
    @update:open="emit('update:open', $event)"
  >
    <template #title>
      <span class="flex items-center gap-2">
        详细配置 · {{ adapter?.manifest.name ?? '设备' }}
      </span>
    </template>
    <template #body>
      <div class="flex max-h-[70vh] flex-col overflow-y-auto pr-1">
        <p
          v-if="!adapter"
          class="py-8 text-center text-sm text-neutral-500"
        >
          未找到适配器「{{ props.pluginId }}」:请先到个人中心 → 功能插件 导入或启用。
        </p>
        <UTabs
          v-else
          v-model="modalTab"
          :items="[
            { label: '配置', value: 'config', slot: 'config', icon: 'i-lucide-settings-2' },
            { label: '手动控制', value: 'control', slot: 'control', icon: 'i-lucide-sliders-horizontal' }
          ]"
          variant="pill"
          color="primary"
          class="mb-4"
        >
          <!-- 配置:安全设置 + 连接 -->
          <template #config>
            <div class="space-y-4">
              <!-- 安全设置 -->
              <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div class="mb-3 text-sm font-semibold">
                  安全设置
                </div>
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-sm font-medium">
                      AI 自主控制
                    </div>
                    <div class="text-xs text-neutral-500">
                      关闭时游戏内 AI 输出的设备事件一律拒绝
                    </div>
                  </div>
                  <USwitch v-model="settings.aiEnabled" />
                </div>
                <!-- 能力设置:总开关关闭时全部隐藏;每项卡片含 AI 开关 + 限制设置 -->
                <template v-if="settings.aiEnabled">
                  <div
                    v-if="capabilities.length"
                    class="mt-3"
                  >
                    <div class="mb-2 text-xs text-neutral-500">
                      能力设置(按能力单独设置)
                    </div>
                    <div class="space-y-2">
                      <div
                        v-for="fn in capabilities"
                        :key="fn.id"
                        class="rounded-lg border border-gray-200 p-2 dark:border-gray-700"
                      >
                        <div class="flex items-center justify-between">
                          <span class="text-sm font-medium">{{ fn.name }}</span>
                          <div class="flex items-center gap-2">
                            <span class="text-xs text-neutral-500">AI 控制</span>
                            <USwitch
                              size="sm"
                              :model-value="isAiFunctionEnabled(settings, fn.id)"
                              @update:model-value="(v: boolean) => {
                                settings.aiEnabledFunctions = toggleAiFunctionEnabled(settings, fn.id, v)
                              }"
                            />
                          </div>
                        </div>
                        <!-- AI 控制未开启:参数部分显示提示,不渲染设置项 -->
                        <p
                          v-if="!isAiFunctionEnabled(settings, fn.id)"
                          class="mt-2 text-xs text-neutral-500"
                        >
                          启用 AI 控制后可设置参数
                        </p>
                        <template v-else>
                          <div class="mt-1">
                            <div class="mb-1 flex justify-between text-[11px] text-neutral-500">
                              <span>最大强度</span>
                              <span class="tabular-nums">{{ fnLimitOf(fn.id).maxIntensity }}</span>
                            </div>
                            <USlider
                              :model-value="fnLimitOf(fn.id).maxIntensity"
                              :min="0"
                              :max="100"
                              @update:model-value="(v: number | undefined) => setFnLimit(fn.id, { maxIntensity: v ?? 0 })"
                            />
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <!-- 连接 -->
              <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div class="mb-3 flex items-center justify-between">
                  <span class="text-sm font-semibold">连接</span>
                  <UBadge
                    variant="soft"
                    :color="toyController.state.connected ? (connectedMock ? 'warning' : 'success') : 'neutral'"
                  >
                    {{ connectedBadge }}
                  </UBadge>
                </div>
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-sm font-medium">
                      真实蓝牙连接
                    </div>
                    <div class="text-xs text-neutral-500">
                      关 = 模拟设备测试(无硬件可用);开 = 真机直连(桌面/Android Chrome)
                    </div>
                  </div>
                  <USwitch v-model="realBle" />
                </div>
                <div class="mt-3 flex gap-2">
                  <UButton
                    v-if="!toyController.state.connected"
                    color="primary"
                    size="sm"
                    :loading="connecting"
                    @click="doConnect()"
                  >
                    {{ realBle ? '连接设备' : '连接模拟设备' }}
                  </UButton>
                  <UButton
                    v-else
                    size="sm"
                    variant="soft"
                    @click="doDisconnect"
                  >
                    断开
                  </UButton>
                  <UButton
                    color="error"
                    size="sm"
                    icon="i-lucide-octagon-alert"
                    :disabled="!toyController.state.connected"
                    @click="toyController.emergencyStop()"
                  >
                    紧急停止
                  </UButton>
                </div>
                <!-- 已授权设备:免系统选择器,点击即直连(首次仍需过一次系统选择器授权) -->
                <div
                  v-if="realBle && !toyController.state.connected && knownDevices.length"
                  class="mt-2 space-y-1"
                >
                  <p class="text-[11px] text-neutral-500">
                    已授权设备(点击直连):
                  </p>
                  <div class="flex flex-wrap gap-1">
                    <UButton
                      v-for="d in knownDevices"
                      :key="d.id"
                      size="xs"
                      variant="soft"
                      icon="i-lucide-bluetooth"
                      :loading="connecting"
                      @click="doConnect(d)"
                    >
                      {{ d.name }}
                    </UButton>
                  </div>
                </div>
                <p
                  v-if="connectedMock"
                  class="mt-2 font-mono text-[11px] leading-tight text-neutral-500"
                >
                  模拟帧:{{ mockLog || '连接后显示收到的字节帧' }}
                </p>
              </div>
            </div>
          </template>

          <!-- 手动控制:纵向滑块,拖动即发,0 即停;未连接时显示引导而非操控 UI -->
          <template #control>
            <div
              v-if="!adapter"
              class="py-6 text-center text-sm text-neutral-500"
            >
              没有可用的适配器:请先到个人中心 → 功能插件 导入或启用。
            </div>
            <div
              v-else-if="!toyController.state.connected"
              class="flex flex-col items-center gap-3 py-10 text-center"
            >
              <UIcon
                name="i-lucide-plug-zap"
                class="size-8 text-neutral-400"
              />
              <div>
                <p class="text-sm font-medium">
                  请先连接设备
                </p>
                <p class="mt-1 text-xs text-neutral-500">
                  到「配置」页连接模拟设备(无硬件测试)或真实蓝牙(桌面/Android Chrome),即可开始手动控制。
                </p>
              </div>
              <UButton
                size="sm"
                color="primary"
                variant="soft"
                @click="modalTab = 'config'"
              >
                去连接
              </UButton>
            </div>
            <div
              v-else-if="!capabilities.length"
              class="py-6 text-center text-sm text-neutral-500"
            >
              该适配器没有声明任何功能。
            </div>
            <div
              v-else
              class="space-y-4"
            >
              <p class="text-xs text-neutral-500">
                拖动滑块即发送,拖到 0 停止;时长到期自动归零。
              </p>
              <div class="flex flex-wrap justify-center divide-x divide-gray-200 dark:divide-gray-700">
                <div
                  v-for="fn in capabilities"
                  :key="fn.id"
                  class="flex flex-col items-center gap-1.5 px-2 py-1"
                >
                  <div class="flex flex-col items-center gap-1">
                    <!-- 功能名 tag:运行中高亮,停止黑字白底 -->
                    <UBadge
                      variant="soft"
                      :color="fnStateOf(fn.id).running ? 'primary' : 'neutral'"
                      :class="!fnStateOf(fn.id).running && 'bg-white text-gray-900 dark:bg-white dark:text-gray-900'"
                    >
                      {{ fn.name }}
                    </UBadge>
                    <span class="text-xs tabular-nums text-neutral-500">
                      {{ toyController.isWaveActive(fn.id)
                        ? '调教中'
                        : (fnStateOf(fn.id).running ? `剩余 ${fnStateOf(fn.id).remainingSec}s` : '已停止') }}
                    </span>
                  </div>
                  <USlider
                    orientation="vertical"
                    :model-value="sliderValueOf(fn.id)"
                    :min="0"
                    :max="100"
                    :disabled="toyController.isWaveActive(fn.id)"
                    class="h-40"
                    :ui="{ root: 'w-5' }"
                    @update:model-value="(v: number | undefined) => onSliderInput(fn.id, v ?? 0)"
                  />
                  <span class="text-sm tabular-nums">{{ sliderValueOf(fn.id) }}</span>
                  <!-- 调教模式:按所选形态运行;运行中切换形态立即生效 -->
                  <UButton
                    size="xs"
                    variant="soft"
                    class="!px-1.5"
                    icon="i-lucide-waves"
                    :color="toyController.isWaveActive(fn.id) ? 'primary' : 'neutral'"
                    @click="toggleWave(fn.id)"
                  >
                    {{ toyController.isWaveActive(fn.id) ? '调教中' : '调教' }}
                  </UButton>
                  <span class="text-[11px] leading-none text-neutral-500">形态</span>
                  <div class="grid grid-cols-4 gap-1">
                    <UButton
                      v-for="p in TRAIN_PATTERN_OPTIONS"
                      :key="p.id"
                      size="xs"
                      variant="soft"
                      class="!px-1"
                      :color="patternOf(fn.id) === p.id ? 'primary' : 'neutral'"
                      @click="selectPattern(fn.id, p.id)"
                    >
                      {{ p.label }}
                    </UButton>
                  </div>
                  <template v-if="fn.supportsMode">
                    <span class="text-[11px] leading-none text-neutral-500">模式</span>
                    <div class="grid grid-cols-2 gap-1">
                      <UButton
                        v-for="m in (fn.modeCount ?? 1)"
                        :key="m"
                        size="xs"
                        variant="soft"
                        class="!px-1.5"
                        :color="draftOf(fn.id).mode === m ? 'primary' : 'neutral'"
                        @click="draftOf(fn.id).mode = m"
                      >
                        {{ m }}
                      </UButton>
                    </div>
                  </template>
                  <span class="text-[11px] leading-none text-neutral-500">时长</span>
                  <div class="grid grid-cols-2 gap-1">
                    <UButton
                      v-for="t in DURATION_TIERS"
                      :key="t.value"
                      size="xs"
                      variant="soft"
                      class="!px-1.5"
                      :color="draftOf(fn.id).duration === t.value ? 'primary' : 'neutral'"
                      @click="draftOf(fn.id).duration = t.value"
                    >
                      {{ t.label }}
                    </UButton>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UModal>
</template>
