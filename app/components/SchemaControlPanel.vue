<script setup lang="ts">
// SchemaControlPanel.vue — 通用插件控制面板:按 PluginSpec.uiSchema 动态渲染控件。
// 控件六种:slider(强度滑块)/ stepper(档位按钮组)/ select / toggle / action(一键动作)/ display(只读状态)。
// 交互统一走 toyController.execute(玩具运行时映射为 DeviceEvent),校验/硬限制链复用。
// autoActive = true 时渲染半透明覆盖层 + loading,阻止玩家手动操作(紧急停止在弹窗外壳)。
import { computed, reactive, watch } from 'vue'
import { toyController } from '../toy/api'
import type { DeviceEvent, ToySettings, TrainPattern } from '#shared/toy'
import { capabilityIntensityParam, capabilityIntensityRange } from '#shared/plugin'
import type { CapabilityDef, ControlDef, ParamDef, PluginSpec, UiGroup } from '#shared/plugin'

const props = withDefaults(defineProps<{
  spec: PluginSpec
  settings: ToySettings
  source?: 'manual' | 'ai'
  autoActive?: boolean
  compact?: boolean
  battery?: number | null
}>(), {
  source: 'manual',
  autoActive: false,
  compact: false,
  battery: null
})

const toast = useToast()

function paramOf(cap: CapabilityDef, key: string): ParamDef | undefined {
  return cap.params.find(p => p.key === key)
}

function defaultParamValue(p: ParamDef): string | number | boolean {
  if (p.type === 'bool') return p.default ?? false
  if (p.type === 'enum') return p.default ?? p.values[0]?.value ?? 0
  return p.default ?? 0
}

// ---- 草稿:每个能力每个参数的当前值(控件编辑;执行时组装为 DeviceEvent) ----

const draft = reactive<Record<string, Record<string, string | number | boolean>>>({})

function draftOf(capId: string, paramKey: string): string | number | boolean {
  const cur = draft[capId]?.[paramKey]
  if (cur !== undefined) return cur
  const cap = props.spec.capabilities.find(c => c.id === capId)
  const p = cap ? paramOf(cap, paramKey) : undefined
  return p ? defaultParamValue(p) : 0
}

function setDraft(capId: string, paramKey: string, v: string | number | boolean): void {
  (draft[capId] ??= {})[paramKey] = v
}

// ---- 执行:capability 草稿 → DeviceEvent → toyController.execute ----

function sendCapability(capId: string): void {
  const cap = props.spec.capabilities.find(c => c.id === capId)
  if (!cap) return
  if (props.spec.runtime.type === 'none') {
    toast.add({ title: '无法执行', description: '该插件没有执行后端(仅 UI/AI 暴露)', color: 'error' })
    return
  }
  const event: DeviceEvent = {
    function: capId,
    intensity: Math.round(Number(draftOf(capId, 'intensity') ?? 0))
  }
  const mode = draftOf(capId, 'mode')
  if (mode !== undefined && mode !== 0 && mode !== '0') {
    event.mode = Math.round(Number(mode))
  }
  const duration = draftOf(capId, 'duration')
  if (duration !== undefined && Number(duration) > 0) {
    event.duration = Math.round(Number(duration))
  }
  void toyController.execute(event, { source: props.source, settings: props.settings, targetId: props.spec.descriptor.id }).then((res) => {
    if (!res.ok) {
      toast.add({ title: '指令被拒绝', description: res.reason, color: 'error' })
    }
  })
}

/** 滑块:拖动即发,150ms 节流(0 即停) */
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>()

function onSliderInput(capId: string, v: number): void {
  setDraft(capId, 'intensity', v)
  const old = sendTimers.get(capId)
  if (old) clearTimeout(old)
  sendTimers.set(capId, setTimeout(() => {
    sendTimers.delete(capId)
    sendCapability(capId)
  }, 150))
}

/** 非滑块控件(档位/下拉/开关/动作):立即发送 */
function onControlChange(capId: string): void {
  sendCapability(capId)
}

/** 一键动作:用控件声明的固定参数发送 */
function onAction(c: Extract<ControlDef, { type: 'action' }>): void {
  const cap = props.spec.capabilities.find(x => x.id === c.capability)
  if (!cap) return
  for (const [k, v] of Object.entries(c.params)) {
    if (paramOf(cap, k)) setDraft(c.capability, k, v)
  }
  sendCapability(c.capability)
}

// ---- 实时状态(display 控件与滑块回显) ----

/** 本面板对应插件的连接槽位(多连接:按 spec.descriptor.id 定位,与其它插件互不干扰) */
const slot = computed(() => toyController.slotOf(props.spec.descriptor.id))

function liveValueOf(capId: string, paramKey: string): string | number {
  const st = slot.value?.functions[capId]
  if (!st) return '—'
  if (paramKey === 'intensity') return st.intensity
  if (paramKey === 'mode') return st.mode ?? 1
  return '—'
}

// 设备状态变化 → 滑块回显(用户拖动中不打断)
watch(() => slot.value?.functions, (fns) => {
  if (!fns) return
  for (const [capId, st] of Object.entries(fns)) {
    if (sendTimers.has(capId)) continue
    const cur = draft[capId]?.intensity
    if (cur !== undefined && cur !== st.intensity) {
      setDraft(capId, 'intensity', st.intensity)
    }
  }
}, { deep: true })

// ---- 渲染辅助 ----

const groups = computed(() => props.spec.uiSchema.groups)
const connected = computed(() => !!slot.value?.connected)

function capabilityOf(capId: string): CapabilityDef | undefined {
  return props.spec.capabilities.find(c => c.id === capId)
}

/** 滑块范围:控件声明优先,回退参数声明 */
function sliderBounds(c: Extract<ControlDef, { type: 'slider' }>): { min: number, max: number, step: number } {
  const cap = capabilityOf(c.bind.capability)
  const p = cap ? paramOf(cap, c.bind.param) : undefined
  const base = p && (p.type === 'int' || p.type === 'float')
    ? { min: p.min ?? 0, max: p.max ?? 100, step: p.step ?? 1 }
    : { min: 0, max: 100, step: 1 }
  return {
    min: c.min ?? base.min,
    max: c.max ?? base.max,
    step: c.step ?? base.step
  }
}

// ---- 调教模式(手动启用;对所有可调强度的能力统一提供) ----

const TRAIN_PATTERN_OPTIONS: { id: TrainPattern, label: string }[] = [
  { id: 'sine', label: '正弦' },
  { id: 'pulse', label: '脉冲' },
  { id: 'sawtooth', label: '锯齿' },
  { id: 'heartbeat', label: '心跳' },
  { id: 'random', label: '漫步' },
  { id: 'constant', label: '恒定' },
  { id: 'auto', label: '全随机' }
]

/** 分组内可调强度的能力(调教行按能力渲染) */
function waveCapsOf(group: UiGroup): CapabilityDef[] {
  const ids = new Set<string>()
  for (const c of group.controls) {
    if (c.type === 'action') ids.add(c.capability)
    else ids.add(c.bind.capability)
  }
  return props.spec.capabilities.filter(cap => ids.has(cap.id) && capabilityIntensityParam(cap) != null)
}

/** 调教形态草稿(未选择时取运行中的形态,缺省随机漫步) */
const draftPattern = reactive<Record<string, TrainPattern>>({})

function patternOf(capId: string): TrainPattern {
  return draftPattern[capId] ?? toyController.wavePatternOf(capId, props.spec.descriptor.id) ?? 'random'
}

function toggleWave(capId: string): void {
  const cap = capabilityOf(capId)
  if (!cap) return
  if (toyController.isWaveActive(capId, props.spec.descriptor.id)) {
    toyController.stopWave(capId, props.spec.descriptor.id)
    return
  }
  void toyController.startWave(capId, capabilityIntensityRange(cap), { pattern: patternOf(capId), settings: props.settings, adapterId: props.spec.descriptor.id })
}

function selectWavePattern(capId: string, p: TrainPattern): void {
  draftPattern[capId] = p
  const cap = capabilityOf(capId)
  if (cap && toyController.isWaveActive(capId, props.spec.descriptor.id)) {
    void toyController.startWave(capId, capabilityIntensityRange(cap), { pattern: p, settings: props.settings, adapterId: props.spec.descriptor.id })
  }
}
</script>

<template>
  <div class="relative">
    <!-- 自动控制中:半透明覆盖层 + loading,阻止手动操作 -->
    <div
      v-if="autoActive"
      class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-white/70 backdrop-blur-sm dark:bg-gray-900/70"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-6 animate-spin text-primary"
      />
      <p class="text-xs font-medium text-primary">
        AI 自动控制中…
      </p>
    </div>

    <!-- 电量(清单声明 battery 时展示) -->
    <div
      v-if="battery != null"
      class="mb-2 flex items-center gap-1 text-[11px] text-neutral-500"
    >
      <UIcon
        name="i-lucide-battery-medium"
        class="size-3.5"
      />
      <span>电量 {{ battery }}%</span>
    </div>

    <div
      v-if="!connected"
      class="py-6 text-center text-sm text-neutral-500"
    >
      设备未连接,无法控制。
    </div>
    <div
      v-else-if="!groups.length"
      class="py-6 text-center text-sm text-neutral-500"
    >
      该插件没有声明任何控件。
    </div>
    <div
      v-else
      class="space-y-4"
    >
      <div
        v-for="group in groups"
        :key="group.id"
      >
        <p class="mb-1.5 text-xs font-medium text-neutral-500">
          {{ group.title }}
        </p>
        <div class="flex flex-wrap justify-center gap-4 divide-x divide-gray-200 dark:divide-gray-700">
          <div
            v-for="control in group.controls"
            :key="`${group.id}:${control.type}`"
            class="flex flex-col items-center gap-1.5 px-2 py-1"
          >
            <template v-if="control.type === 'slider'">
              <span class="text-xs tabular-nums text-neutral-500">
                {{ draftOf(control.bind.capability, control.bind.param) }}
              </span>
              <USlider
                orientation="vertical"
                :model-value="Number(draftOf(control.bind.capability, control.bind.param))"
                :min="sliderBounds(control).min"
                :max="sliderBounds(control).max"
                :step="sliderBounds(control).step"
                :disabled="autoActive"
                :class="compact ? 'h-24' : 'h-36'"
                :ui="{ root: 'w-5' }"
                @update:model-value="(v: number | undefined) => onSliderInput(control.bind.capability, v ?? 0)"
              />
            </template>

            <template v-else-if="control.type === 'stepper'">
              <span
                v-if="control.bind.param === 'duration'"
                class="text-[11px] leading-none text-neutral-500"
              >时长</span>
              <span
                v-else-if="control.bind.param === 'mode'"
                class="text-[11px] leading-none text-neutral-500"
              >模式</span>
              <div :class="control.values.length > 3 ? 'grid grid-cols-2 gap-1' : 'flex gap-1'">
                <UButton
                  v-for="v in control.values"
                  :key="String(v.value)"
                  size="xs"
                  variant="soft"
                  class="!px-1.5"
                  :color="draftOf(control.bind.capability, control.bind.param) === v.value ? 'primary' : 'neutral'"
                  :disabled="autoActive"
                  @click="setDraft(control.bind.capability, control.bind.param, v.value); onControlChange(control.bind.capability)"
                >
                  {{ v.label }}
                </UButton>
              </div>
            </template>

            <template v-else-if="control.type === 'select'">
              <USelect
                size="sm"
                :model-value="String(draftOf(control.bind.capability, control.bind.param))"
                :items="(control.options ?? []).map(o => ({ label: o.label, value: String(o.value) }))"
                value-key="value"
                :disabled="autoActive"
                class="w-28"
                @update:model-value="(v: string | undefined) => { setDraft(control.bind.capability, control.bind.param, v ?? ''); onControlChange(control.bind.capability) }"
              />
            </template>

            <template v-else-if="control.type === 'toggle'">
              <span class="text-xs text-neutral-500">
                {{ control.label ?? control.bind.param }}
              </span>
              <USwitch
                size="sm"
                :model-value="Boolean(draftOf(control.bind.capability, control.bind.param))"
                :disabled="autoActive"
                @update:model-value="(v: boolean) => { setDraft(control.bind.capability, control.bind.param, v); onControlChange(control.bind.capability) }"
              />
            </template>

            <template v-else-if="control.type === 'action'">
              <UButton
                size="xs"
                color="primary"
                variant="soft"
                icon="i-lucide-zap"
                :disabled="autoActive"
                @click="onAction(control)"
              >
                {{ control.label }}
              </UButton>
            </template>

            <template v-else-if="control.type === 'display'">
              <span class="text-xs text-neutral-500">
                {{ control.label ?? control.bind.param }}
              </span>
              <span class="text-sm tabular-nums">
                {{ liveValueOf(control.bind.capability, control.bind.param) }}
              </span>
            </template>
          </div>
        </div>
        <!-- 调教模式:可调强度的能力统一提供(手动启用;自动控制期间锁定) -->
        <div
          v-if="waveCapsOf(group).length"
          class="mt-3 space-y-2 border-t border-gray-200 pt-2 dark:border-gray-700"
        >
          <div
            v-for="cap in waveCapsOf(group)"
            :key="cap.id"
            class="flex flex-wrap items-center justify-center gap-1.5"
          >
            <UButton
              size="xs"
              variant="soft"
              icon="i-lucide-waves"
              :color="toyController.isWaveActive(cap.id, props.spec.descriptor.id) ? 'primary' : 'neutral'"
              :disabled="autoActive"
              @click="toggleWave(cap.id)"
            >
              {{ toyController.isWaveActive(cap.id, props.spec.descriptor.id) ? '调教中' : '调教' }}
            </UButton>
            <span class="text-[11px] leading-none text-neutral-500">形态</span>
            <div class="grid grid-cols-4 gap-1">
              <UButton
                v-for="p in TRAIN_PATTERN_OPTIONS"
                :key="p.id"
                size="xs"
                variant="soft"
                class="!px-1"
                :color="patternOf(cap.id) === p.id ? 'primary' : 'neutral'"
                :disabled="autoActive"
                @click="selectWavePattern(cap.id, p.id)"
              >
                {{ p.label }}
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
