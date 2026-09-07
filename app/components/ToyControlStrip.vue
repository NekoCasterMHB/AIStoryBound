<script setup lang="ts">
// ToyControlStrip.vue — 游戏页顶栏设备入口(图标 + 手风琴弹出面板):
// 有已启用插件时在顶栏显示连接状态图标,点击弹出手风琴面板:每个已启用插件一个折叠项,
// 标题行 = 连接状态点 + 插件名 + 连接徽标;展开区 = 连接/断开、电量、紧凑 SchemaControlPanel。
// UAccordion 默认 single 模式:展开一个其余自动收起;unmount-on-hide 关闭让各设备控件草稿在切换间保留。
// 紧急停止为全局按钮(作用于全部连接);连接走 ToyQuickConnectModal(系统选择器/已授权直连)。
import { computed, onMounted, ref, watch } from 'vue'
import type { AccordionItem } from '@nuxt/ui'
import { DEFAULT_TOY_SETTINGS, isAdapterEnabled } from '#shared/toy'
import type { ToySettings } from '#shared/toy'
import type { PluginSpec } from '#shared/plugin'
import { toyController } from '../toy/api'
import { loadToySettings, saveToySettings } from '../toy/store'
import { loadAllPluginSpecs } from '../toy/runtime/adapter-loader'
import { createWebBluetoothTransport } from '../toy/transports/web-bluetooth'

const settings = ref<ToySettings>({ ...DEFAULT_TOY_SETTINGS })
const specs = ref<PluginSpec[]>([])
const open = ref(false)
const pickerOpen = ref(false)
/** 快速连接的目标插件 id(点某折叠项「连接设备」时记录) */
const pickerTargetId = ref<string | null>(null)
/** 当前展开的折叠项(plugin id;single 模式下展开一个其余自动收起) */
const expanded = ref<string | undefined>(undefined)

/** 有已启用插件才显示图标 */
const show = computed(() => specs.value.length > 0)

/** 手风琴折叠项:每个已启用插件一项,value = plugin id(展开态跟踪用) */
const items = computed<AccordionItem[]>(() => specs.value.map(s => ({
  label: s.descriptor.name,
  value: s.descriptor.id
})))

function specOf(id: unknown): PluginSpec | null {
  return typeof id === 'string' ? specs.value.find(s => s.descriptor.id === id) ?? null : null
}

function isConnected(id: unknown): boolean {
  return typeof id === 'string' && !!toyController.slotOf(id)?.connected
}

const connectedCount = computed(() => specs.value.filter(s => isConnected(s.descriptor.id)).length)
const anyConnected = computed(() => connectedCount.value > 0)

/** 快速连接目标(找不到已删除插件时不渲染弹窗) */
const pickerTarget = computed(() => specOf(pickerTargetId.value))

/** 各插件电量(按 plugin id;仅 Web Bluetooth 直连可读,其余为 null) */
const batteries = ref<Record<string, number | null>>({})

function refreshBatteries(): void {
  const out: Record<string, number | null> = {}
  for (const s of specs.value) {
    const slot = toyController.slotOf(s.descriptor.id)
    out[s.descriptor.id] = slot && slot.transportId === 'web-bluetooth' && slot.deviceId
      ? createWebBluetoothTransport().getBattery?.(slot.deviceId) ?? null
      : null
  }
  batteries.value = out
}

async function load(): Promise<void> {
  settings.value = await loadToySettings()
  specs.value = (await loadAllPluginSpecs()).filter(s => isAdapterEnabled(settings.value, s.descriptor.id))
}

onMounted(load)

/** 连接状态签名(任一设备连接/断开时变化) */
const connSig = computed(() => specs.value.map(s => `${s.descriptor.id}:${isConnected(s.descriptor.id)}`).join(','))

// 打开面板:刷新电量;折叠项默认全部收起(玩家自行点开需要的那台设备)。
// 只监听 open(面板开着时连接状态变化不应收起玩家正在查看的折叠项);电量刷新另由 connSig watch 负责
watch(open, (on) => {
  if (!on) return
  refreshBatteries()
  expanded.value = undefined
})

// 面板开着时设备连接/断开 → 刷新电量显示
watch(connSig, () => {
  if (open.value) refreshBatteries()
})

/** 从某折叠项发起连接:收起面板,记下目标插件,弹系统选择器 */
function doConnect(id: string): void {
  pickerTargetId.value = id
  open.value = false
  pickerOpen.value = true
}

/** AI 自主控制总开关(全局):面板顶部直开,切换即落盘;游戏页每回合重读设置,即时生效 */
function toggleAiMaster(on: boolean) {
  settings.value = { ...settings.value, aiEnabled: on }
  void saveToySettings(settings.value)
}

/** 紧急停止后的「全部已停」展示态:任一设备出现新输出(强度>0/调教中)自动回到紧急停止态 */
const allStopped = ref(false)

/** 活动输出签名(响应式):已连接设备任一功能强度>0 或调教中即置 1 */
const activeSig = computed(() => specs.value.map((s) => {
  const slot = toyController.slotOf(s.descriptor.id)
  if (!slot?.connected) return '0'
  return Object.values(slot.functions).some(f => f.intensity > 0 || f.wave) ? '1' : '0'
}).join(''))

// 有设备开始输出 → 退出「已停止」展示态,按钮恢复为紧急停止
watch(activeSig, (sig) => {
  if (sig.includes('1')) allStopped.value = false
})

async function doEmergencyStop() {
  await toyController.emergencyStop()
  allStopped.value = anyConnected.value
}
</script>

<template>
  <UPopover
    v-if="show"
    v-model:open="open"
    :content="{ align: 'end', sideOffset: 8 }"
  >
    <UButton
      label="功能插件"
      color="neutral"
      variant="outline"
      icon="i-lucide-plug-zap"
      size="sm"
      :title="anyConnected ? `${connectedCount} 台设备已连接` : '连接外部设备'"
      aria-label="外部设备"
    />

    <template #content>
      <div class="w-72 p-3">
        <!-- AI 自主控制总开关(全局):面板顶部,游戏内直开直关 -->
        <div class="mb-2 flex items-center justify-between rounded-lg border border-gray-200 px-2.5 py-1.5 dark:border-gray-700">
          <div class="flex items-center gap-1.5">
            <UIcon
              name="i-lucide-bot"
              class="size-4 text-neutral-500"
            />
            <span class="text-xs font-medium">AI 自主控制</span>
          </div>
          <USwitch
            size="sm"
            :model-value="settings.aiEnabled"
            @update:model-value="toggleAiMaster"
          />
        </div>

        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="truncate text-xs font-medium text-neutral-500">
            {{ specs.length }} 个插件 · {{ connectedCount }} 个已连接
          </p>
          <UBadge
            variant="soft"
            :color="anyConnected ? 'success' : 'neutral'"
          >
            {{ anyConnected ? '设备在线' : '设备未连接' }}
          </UBadge>
        </div>

        <!-- 紧急停止:全局按钮,作用于全部连接;停止后变为「已停止」反馈态,有新输出自动恢复 -->
        <UButton
          block
          size="xs"
          :color="allStopped ? 'success' : 'error'"
          variant="soft"
          :icon="allStopped ? 'i-lucide-circle-check' : 'i-lucide-octagon-alert'"
          :disabled="!anyConnected || allStopped"
          class="mb-2"
          @click="doEmergencyStop"
        >
          {{ allStopped ? '所有设备已停止' : '紧急停止(全部设备)' }}
        </UButton>

        <div class="max-h-[50vh] overflow-y-auto">
          <UAccordion
            v-model="expanded"
            :items="items"
            :unmount-on-hide="false"
          >
            <!-- 标题行:连接状态点 -->
            <template #leading="{ item }">
              <span
                class="size-2 shrink-0 rounded-full"
                :class="isConnected(item.value) ? 'bg-success' : 'bg-neutral-300 dark:bg-neutral-600'"
              />
            </template>

            <!-- 标题行右侧:连接徽标 + 展开箭头(覆写默认箭头以保留旋转动效) -->
            <template #trailing="{ item }">
              <span class="ms-auto flex items-center gap-1.5">
                <UBadge
                  variant="soft"
                  :color="isConnected(item.value) ? 'success' : 'neutral'"
                >
                  {{ isConnected(item.value) ? '已连接' : '未连接' }}
                </UBadge>
                <UIcon
                  name="i-lucide-chevron-down"
                  class="size-5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
                />
              </span>
            </template>

            <!-- 展开区:该设备的连接入口(未连接时)+ 电量 + 控制面板;断开统一在个人中心插件卡片操作 -->
            <template #body="{ item }">
              <div v-if="specOf(item.value)">
                <div class="mb-2 flex flex-wrap items-center gap-1.5">
                  <UButton
                    v-if="!isConnected(item.value)"
                    size="xs"
                    color="primary"
                    variant="soft"
                    icon="i-lucide-bluetooth"
                    @click="doConnect(String(item.value))"
                  >
                    连接设备
                  </UButton>
                  <span
                    v-if="batteries[String(item.value)] != null"
                    class="text-[11px] text-neutral-500"
                  >
                    电量 {{ batteries[String(item.value)] }}%
                  </span>
                </div>

                <SchemaControlPanel
                  :spec="specOf(item.value)!"
                  :settings="settings"
                  source="manual"
                  :auto-active="isConnected(item.value) && !!toyController.slotOf(String(item.value))?.autoActive"
                  :compact="true"
                  :battery="batteries[String(item.value)] ?? null"
                />
              </div>
            </template>
          </UAccordion>
        </div>
      </div>
    </template>
  </UPopover>

  <!-- 快捷连接(新设备走系统选择器;已授权点选直连) -->
  <ToyQuickConnectModal
    v-if="pickerTarget"
    v-model:open="pickerOpen"
    :adapter-id="pickerTarget.descriptor.id"
    :adapter-name="pickerTarget.descriptor.name"
  />
</template>
