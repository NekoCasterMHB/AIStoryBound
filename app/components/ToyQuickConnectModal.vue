<script setup lang="ts">
// ToyQuickConnectModal.vue — 「快捷连接」自定义设备选择器(卡片右上角「未连接」标签进入)。
// 已授权设备用自定义 UI 列出(免系统选择器,点击即连),电量展示连接时读取的缓存值;
// 新硬件走「扫描新设备」,仅此一步需要系统选择器,授权后进入已授权列表,之后不再弹出。
// 断开走卡片标签的确认框,不在本弹窗内。
import { toyController } from '../toy/api'
import { webBluetoothTransport } from '../toy/transports/web-bluetooth'
import type { ToyTransportDevice } from '../toy/transports/transport'
import { loadAllAdapters } from '../toy/runtime/adapter-loader'
import type { ToyAdapter } from '#shared/toy'

const props = defineProps<{ open: boolean, adapterId: string, adapterName: string }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const toast = useToast()

interface PickerDevice extends ToyTransportDevice {
  battery: number | null
}

const adapter = ref<ToyAdapter | null>(null)
const devices = ref<PickerDevice[]>([])
const busy = ref(false)

/** 刷新已授权设备列表(电量取连接时缓存,未连过为未知) */
async function refreshKnown() {
  const known = (await webBluetoothTransport.listKnownDevices?.()) ?? []
  devices.value = known.map(d => ({
    ...d,
    battery: webBluetoothTransport.getBattery?.(d.id) ?? null
  }))
}

watch(() => props.open, async (open) => {
  if (!open) return
  adapter.value = (await loadAllAdapters()).find(a => a.manifest.id === props.adapterId) ?? null
  devices.value = []
  void refreshKnown()
})

/** 单连接槽位:已连其他适配器时先断开 */
async function ensureFreeSlot(): Promise<void> {
  if (toyController.state.connected && toyController.state.adapterId !== props.adapterId) {
    await toyController.disconnect()
  }
}

/** 通过系统选择器连接新设备/重新授权(返回是否成功) */
async function connectWithChooser(): Promise<boolean> {
  if (!adapter.value) return false
  await ensureFreeSlot()
  const res = await toyController.connect(adapter.value, webBluetoothTransport)
  if (!res.ok) {
    toast.add({ title: '连接失败', description: res.reason, color: 'error' })
    return false
  }
  await refreshKnown()
  toast.add({ title: '已连接', description: `${adapter.value.manifest.name} · ${toyController.state.deviceName}`, color: 'success' })
  return true
}

/** 连接一个设备(已授权列表项);成功返回 true */
async function connectDevice(d: PickerDevice): Promise<boolean> {
  if (!adapter.value) return false
  await ensureFreeSlot()
  const res = await toyController.connect(adapter.value, webBluetoothTransport, { device: d })
  if (!res.ok) {
    // 本地缓存有记录但 Chrome 拿不到设备句柄(getDevices 未返回)→ 只能重新授权一次
    if (res.reason.includes('授权记录丢失')) {
      toast.add({ title: '需要重新授权', description: '系统未返回该设备的授权记录,请在系统蓝牙弹窗中再次选择该设备', color: 'warning' })
      return connectWithChooser()
    }
    toast.add({ title: '连接失败', description: res.reason, color: 'error' })
    return false
  }
  d.battery = webBluetoothTransport.getBattery?.(d.id) ?? null
  toast.add({ title: '已连接', description: `${adapter.value.manifest.name} · ${toyController.state.deviceName}`, color: 'success' })
  return true
}

async function pick(d: PickerDevice) {
  if (busy.value || !adapter.value) return
  busy.value = true
  try {
    if (await connectDevice(d)) emit('update:open', false)
  } finally {
    busy.value = false
  }
}

/** 扫描新设备:唯一需要系统选择器的一步(requestDevice 必须在用户手势内,本按钮点击即手势) */
async function scanNew() {
  if (busy.value || !adapter.value) return
  busy.value = true
  try {
    if (await connectWithChooser()) emit('update:open', false)
  } finally {
    busy.value = false
  }
}

function batteryIcon(v: number): string {
  if (v >= 50) return 'i-lucide-battery-full'
  if (v >= 20) return 'i-lucide-battery-medium'
  return 'i-lucide-battery-low'
}

function batteryColor(v: number): string {
  if (v >= 50) return 'text-success'
  if (v >= 20) return 'text-warning'
  return 'text-error'
}
</script>

<template>
  <UModal
    :open="props.open"
    :ui="{ content: 'sm:max-w-md!' }"
    @update:open="emit('update:open', $event)"
  >
    <template #title>
      <span class="flex items-center gap-2">
        <UIcon
          name="i-lucide-bluetooth"
          class="size-4 text-primary"
        />
        连接设备 · {{ props.adapterName }}
      </span>
    </template>
    <template #body>
      <div class="space-y-3">
        <p
          v-if="!adapter"
          class="py-6 text-center text-sm text-neutral-500"
        >
          未找到适配器「{{ props.adapterId }}」,请先到功能插件页确认已解锁。
        </p>
        <template v-else>
          <p class="text-xs text-neutral-500">
            已授权设备点击即连,无需系统选择器;新设备先点下方「扫描新设备」。
          </p>
          <!-- 已授权设备列表(自定义 UI) -->
          <div
            v-if="devices.length"
            class="space-y-2"
          >
            <div
              v-for="d in devices"
              :key="d.id"
              class="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
            >
              <div class="flex min-w-0 items-center gap-2">
                <UIcon
                  name="i-lucide-bluetooth"
                  class="size-4 shrink-0 text-primary"
                />
                <span class="truncate text-sm font-medium">{{ d.name }}</span>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <span
                  v-if="d.battery != null"
                  class="flex items-center gap-1 text-xs"
                  :class="batteryColor(d.battery)"
                >
                  <UIcon
                    :name="batteryIcon(d.battery)"
                    class="size-3.5"
                  />
                  {{ d.battery }}%
                </span>
                <UButton
                  size="xs"
                  color="primary"
                  :loading="busy"
                  @click="pick(d)"
                >
                  连接
                </UButton>
              </div>
            </div>
          </div>
          <!-- 空态 -->
          <div
            v-else
            class="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700"
          >
            暂无已授权设备,点击下方按钮扫描
          </div>
          <UButton
            block
            color="primary"
            variant="soft"
            icon="i-lucide-radar"
            :loading="busy"
            @click="scanNew"
          >
            扫描新设备
          </UButton>
        </template>
      </div>
    </template>
  </UModal>
</template>
