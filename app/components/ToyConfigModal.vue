<script setup lang="ts">
// ToyConfigModal.vue — 单个适配器的「详细配置」弹窗(由个人中心 → 功能插件 的适配器列表打开)。
// 只负责该适配器的配置与控制:安全设置、连接、手动控制(纵向滑块,拖动即发,0 即停,倒计时自动归零)。
// 多连接:本弹窗只操作 props.pluginId 对应的连接槽位;每插件使用独立 transport 实例(真机/模拟),互不干扰。
import { computed, ref, watch } from 'vue'
import { DEFAULT_FUNCTION_MAX_INTENSITY, DEFAULT_TOY_SETTINGS, functionLimitOf, isAiFunctionEnabled, toggleAiFunctionEnabled, functionKey } from '#shared/toy'
import type { ToyAdapter, ToyFunctionLimit, ToySettings } from '#shared/toy'
import type { PluginSpec } from '#shared/plugin'
import { toyController } from '../toy/api'
import { loadToySettings, saveToySettings } from '../toy/store'
import { createMockTransport } from '../toy/transports/mock'
import { createWebBluetoothTransport } from '../toy/transports/web-bluetooth'
import type { ToyTransport, ToyTransportDevice } from '../toy/transports/transport'
import { loadAllAdapters, loadAllPluginSpecs } from '../toy/runtime/adapter-loader'

const props = defineProps<{ open: boolean, pluginId: string }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const toast = useToast()

/** 弹窗内 tab:配置(安全设置/连接)与手动控制(纵向滑块) */
const modalTab = ref<'config' | 'control'>('config')

const settings = ref<ToySettings>({ ...DEFAULT_TOY_SETTINGS })
/** 本弹窗锁定的适配器(pluginId 定位;未导入时提示去功能插件页导入) */
const adapter = ref<ToyAdapter | null>(null)
/** 本弹窗对应的插件规格(SchemaControlPanel 渲染用) */
const spec = ref<PluginSpec | null>(null)
const capabilities = computed(() => adapter.value?.manifest.capabilities?.functions ?? [])
/** 模拟/真机切换开关:开 = 真实蓝牙直连,关 = 模拟设备 */
const realBle = ref(false)
const connecting = ref(false)

/** 当前连接槽位(多连接:按 pluginId 定位,与其它插件互不干扰) */
const slot = computed(() => toyController.slotOf(props.pluginId))
const connected = computed(() => !!slot.value?.connected)
const connectedMock = computed(() => slot.value?.connected && slot.value.transportId === 'mock')
const connectedBadge = computed(() => {
  if (!connected.value) return realBle.value ? '未连接' : '未连接 · 模拟模式'
  return connectedMock.value ? `模拟测试 · ${slot.value?.deviceName}` : `已连接 · ${slot.value?.deviceName}`
})

/** 本插件已连接时使用的 transport 实例(电量/模拟日志读取;多连接下每插件独立实例) */
const liveTransport = ref<ToyTransport | null>(null)

/** 模拟传输日志(本插件连接的实例;独立于其它插件的模拟状态) */
const mockLog = computed(() => {
  const t = liveTransport.value as { state?: { writeLog?: string[] } } | null
  return t?.state?.writeLog?.slice(-3).join('\n') ?? ''
})

// ---- 按能力单独的限制(未单独设置的字段回落全局默认;多设备按 pluginId 命名空间) ----

function fnLimitOf(fnId: string): { maxIntensity: number } {
  // 生效上限 = min(清单声明强度上限, 用户覆盖);清单声明值来自 manifest.capabilities
  const fn = capabilities.value.find(f => f.id === fnId)
  const declaredMax = fn?.intensityRange?.[1] ?? DEFAULT_FUNCTION_MAX_INTENSITY
  return functionLimitOf(settings.value, fnId, declaredMax, props.pluginId)
}

function setFnLimit(fnId: string, patch: Partial<ToyFunctionLimit>) {
  const key = functionKey(props.pluginId, fnId)
  settings.value.functionLimits = {
    ...(settings.value.functionLimits ?? {}),
    [key]: { ...(settings.value.functionLimits?.[key] ?? {}), ...patch }
  }
}

/** 打开时载入设置并定位本弹窗对应的适配器与插件规格;设置变更即时落盘 */
watch(() => props.open, async (open) => {
  if (!open) return
  settings.value = await loadToySettings()
  const [all, specs] = await Promise.all([loadAllAdapters(), loadAllPluginSpecs()])
  adapter.value = all.find(a => a.manifest.id === props.pluginId) ?? null
  spec.value = specs.find(s => s.descriptor.id === props.pluginId) ?? null
  liveTransport.value = null
  modalTab.value = 'config'
}, { immediate: true })

watch(settings, (s) => {
  void saveToySettings(s)
}, { deep: true })

// ---- 连接 ----

/** 已授权设备(Web Bluetooth getDevices,免系统选择器;仅含此前用户授权过的设备,点击即直连) */
const knownDevices = ref<ToyTransportDevice[]>([])
async function loadKnownDevices() {
  const bt = createWebBluetoothTransport()
  knownDevices.value = (await bt.listKnownDevices?.()) ?? []
}
// 打开弹窗/切到真机时刷新已授权设备列表
watch(realBle, (on) => {
  if (on) void loadKnownDevices()
})

async function doConnect(device?: ToyTransportDevice) {
  if (!adapter.value || connecting.value || connected.value) return
  connecting.value = true
  try {
    // 每插件独立 transport 实例(多连接下 mock/真机各自状态;连接成功后保存实例供电量/日志读取)
    const transport = realBle.value ? createWebBluetoothTransport() : createMockTransport()
    const res = await toyController.connect(adapter.value, transport, device ? { device } : {})
    if (!res.ok) {
      toast.add({ title: '连接失败', description: res.reason, color: 'error' })
      return
    }
    liveTransport.value = transport
    // 真机通过系统选择器连上后刷新列表,下次可免选择器直连
    void loadKnownDevices()
    if (connectedMock.value) {
      toast.add({ title: '模拟测试已连接', description: '当前为模拟设备,不会控制真实硬件;打开「真实蓝牙连接」开关即可连真机', color: 'success' })
    } else {
      toast.add({ title: '已连接', description: `${adapter.value.manifest.name} · ${slot.value?.deviceName}`, color: 'success' })
    }
  } finally {
    connecting.value = false
  }
}

async function doDisconnect() {
  await toyController.disconnect(props.pluginId)
  liveTransport.value = null
  toast.add({ title: '已断开', color: 'neutral' })
}

// ---- 手动控制:委托 SchemaControlPanel(按插件清单 uiSchema 渲染);电量取传输缓存 ----

/** 真机连接时的电量缓存(连接时读取;模拟设备无电量) */
const batteryNow = computed(() => {
  const s = slot.value
  if (!s || s.transportId !== 'web-bluetooth' || !s.deviceId) return null
  return liveTransport.value?.getBattery?.(s.deviceId) ?? null
})
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
                              :model-value="isAiFunctionEnabled(settings, fn.id, props.pluginId)"
                              @update:model-value="(v: boolean) => {
                                settings.aiEnabledFunctions = toggleAiFunctionEnabled(settings, fn.id, v, props.pluginId)
                              }"
                            />
                          </div>
                        </div>
                        <!-- AI 控制未开启:参数部分显示提示,不渲染设置项 -->
                        <p
                          v-if="!isAiFunctionEnabled(settings, fn.id, props.pluginId)"
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
                    :color="connected ? (connectedMock ? 'warning' : 'success') : 'neutral'"
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
                    v-if="!connected"
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
                    :disabled="!connected"
                    @click="toyController.emergencyStop()"
                  >
                    紧急停止
                  </UButton>
                </div>
                <!-- 已授权设备:免系统选择器,点击即直连(首次仍需过一次系统选择器授权) -->
                <div
                  v-if="realBle && !connected && knownDevices.length"
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

          <!-- 手动控制:按插件清单 uiSchema 动态渲染(滑块/档位);未连接时显示引导 -->
          <template #control>
            <div
              v-if="!spec"
              class="py-6 text-center text-sm text-neutral-500"
            >
              没有可用的插件:请先到个人中心 → 功能插件 导入或启用。
            </div>
            <div
              v-else-if="!connected"
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
              v-else
              class="space-y-4"
            >
              <p class="text-xs text-neutral-500">
                拖动滑块即发送,拖到 0 停止;时长到期自动归零。自动指令生效期间面板锁定。
              </p>
              <SchemaControlPanel
                :spec="spec"
                :settings="settings"
                source="manual"
                :auto-active="slot?.autoActive ?? false"
                :battery="batteryNow"
              />
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UModal>
</template>
