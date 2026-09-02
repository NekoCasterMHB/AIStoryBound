<script setup lang="ts">
// ToyControlStrip.vue — 游戏页顶栏设备入口(图标 + 弹出菜单):
// 有已启用插件时在顶栏显示连接状态图标,点击弹出菜单:连接状态/电量、连接·断开·紧急停止、
// 紧凑 SchemaControlPanel。多连接下 target = 已连接插件优先(active 优先),否则第一个已启用;
// 断开/紧急停止作用于 target 对应连接,不影响其它插件连接。
import { computed, onMounted, ref, watch } from 'vue'
import { DEFAULT_TOY_SETTINGS, isAdapterEnabled } from '#shared/toy'
import type { ToySettings } from '#shared/toy'
import type { PluginSpec } from '#shared/plugin'
import { toyController } from '../toy/api'
import { loadToySettings } from '../toy/store'
import { loadAllPluginSpecs } from '../toy/runtime/adapter-loader'
import { createWebBluetoothTransport } from '../toy/transports/web-bluetooth'

const settings = ref<ToySettings>({ ...DEFAULT_TOY_SETTINGS })
const specs = ref<PluginSpec[]>([])
const open = ref(false)
const pickerOpen = ref(false)

/** 有已启用插件才显示图标 */
const show = computed(() => specs.value.length > 0)

/** 目标插件:已连接优先(active 优先),否则第一个已启用 */
const target = computed<PluginSpec | null>(() => {
  const connected = specs.value.find(s => !!toyController.slotOf(s.descriptor.id))
  return connected ?? specs.value[0] ?? null
})

/** 目标插件对应的连接槽位状态 */
const slot = computed(() => (target.value ? toyController.slotOf(target.value.descriptor.id) : undefined))
const connected = computed(() => !!slot.value?.connected)
const connectedBadge = computed(() => {
  if (!connected.value) return '设备未连接'
  return `${slot.value?.adapterName ?? '设备'} · ${slot.value?.deviceName ?? ''}`
})

const battery = ref<number | null>(null)

function refreshBattery(): void {
  const s = slot.value
  if (s && s.transportId === 'web-bluetooth' && s.deviceId) {
    battery.value = createWebBluetoothTransport().getBattery?.(s.deviceId) ?? null
  } else {
    battery.value = null
  }
}

async function load(): Promise<void> {
  settings.value = await loadToySettings()
  specs.value = (await loadAllPluginSpecs()).filter(s => isAdapterEnabled(settings.value, s.descriptor.id))
}

onMounted(load)

// 连接状态变化时刷新电量
watch(() => [connected.value, slot.value?.deviceId], () => {
  if (open.value) refreshBattery()
})

watch(open, (on) => {
  if (on) refreshBattery()
})

async function doConnect(): Promise<void> {
  if (!target.value || connected.value) return
  open.value = false
  pickerOpen.value = true
}
</script>

<template>
  <UPopover
    v-if="show && target"
    v-model:open="open"
    :content="{ align: 'end', sideOffset: 8 }"
  >
    <UButton
      label="功能插件"
      color="neutral"
      variant="outline"
      icon="i-lucide-plug-zap"
      size="sm"
      :title="connected ? `设备已连接:${slot?.deviceName ?? ''}` : '连接外部设备'"
      aria-label="外部设备"
    />

    <template #content>
      <div class="w-72 p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="truncate text-xs font-medium text-neutral-500">
            {{ target.descriptor.name }}
          </p>
          <span class="flex shrink-0 items-center gap-1.5">
            <span
              v-if="battery != null"
              class="text-[11px] text-neutral-500"
            >
              电量 {{ battery }}%
            </span>
            <UBadge
              variant="soft"
              :color="connected ? 'success' : 'neutral'"
            >
              {{ connectedBadge }}
            </UBadge>
          </span>
        </div>

        <div class="mb-2 flex flex-wrap gap-1.5">
          <UButton
            v-if="!connected"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-lucide-bluetooth"
            @click="doConnect"
          >
            连接设备
          </UButton>
          <UButton
            v-else
            size="xs"
            variant="soft"
            icon="i-lucide-unplug"
            @click="toyController.disconnect(target.descriptor.id)"
          >
            断开
          </UButton>
          <UButton
            size="xs"
            color="error"
            variant="soft"
            icon="i-lucide-octagon-alert"
            :disabled="!connected"
            @click="toyController.emergencyStop()"
          >
            紧急停止
          </UButton>
        </div>

        <div class="max-h-[50vh] overflow-y-auto">
          <SchemaControlPanel
            :spec="target"
            :settings="settings"
            source="manual"
            :auto-active="slot?.autoActive ?? false"
            :compact="true"
            :battery="battery"
          />
        </div>
      </div>
    </template>
  </UPopover>

  <!-- 快捷连接(新设备走系统选择器;已授权点选直连) -->
  <ToyQuickConnectModal
    v-if="target"
    v-model:open="pickerOpen"
    :adapter-id="target.descriptor.id"
    :adapter-name="target.descriptor.name"
  />
</template>
