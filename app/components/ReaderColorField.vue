<script setup lang="ts">
// 颜色选择器弹层:图形拾色 + 下方输入框支持直接输入颜色值,可切换 HEX / RGBA 格式。
// 内部统一存规范化的 hex(含 8 位 #rrggbbaa 表示透明度),CSS 与 UColorPicker 均兼容。
const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()

const open = ref(false)
const format = ref<'hex' | 'rgba'>('hex')
const input = ref('')
const invalid = ref(false)

const formatItems = [
  { label: 'HEX', value: 'hex' },
  { label: 'RGBA', value: 'rgba' }
] satisfies { label: string, value: 'hex' | 'rgba' }[]

interface RGBA { r: number, g: number, b: number, a: number }

function parseHex(h: string): RGBA | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(h.trim())
  if (!m) return null
  let s = m[1]!
  if (s.length === 3 || s.length === 4) s = s.split('').map(c => c + c).join('')
  return {
    r: parseInt(s.slice(0, 2), 16)!,
    g: parseInt(s.slice(2, 4), 16)!,
    b: parseInt(s.slice(4, 6), 16)!,
    a: s.length >= 8 ? parseInt(s.slice(6, 8), 16)! / 255 : 1
  }
}

function toHex(p: RGBA): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  let s = `#${h(p.r)}${h(p.g)}${h(p.b)}`
  if (p.a < 1) s += h(p.a * 255)
  return s
}

function toRgba(p: RGBA): string {
  if (p.a >= 1) return `rgb(${p.r}, ${p.g}, ${p.b})`
  return `rgba(${p.r}, ${p.g}, ${p.b}, ${Math.round(p.a * 100) / 100})`
}

/** 解析 hex / rgb() / rgba() / 裸 r,g,b[,a] 输入 */
function parseColor(t: string): RGBA | null {
  const hex = parseHex(t)
  if (hex) return hex
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(t.trim())
  const naked = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?)\s*)?$/.exec(t.trim())
  const g = m ?? naked
  if (!g) return null
  const aRaw = g[4]
  const alpha = !aRaw ? 1 : aRaw.endsWith('%') ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw)
  const r = Number(g[1])
  const gg = Number(g[2])
  const b = Number(g[3])
  if (r > 255 || gg > 255 || b > 255 || alpha > 1) return null
  return { r, g: gg, b, a: alpha }
}

function syncInput() {
  invalid.value = false
  const v = props.modelValue
  input.value = v ? (format.value === 'hex' ? v : toRgba(parseHex(v) ?? { r: 0, g: 0, b: 0, a: 1 })) : ''
}

/** 切换格式时把当前颜色转成对应写法显示在输入框 */
function switchFormat(f: 'hex' | 'rgba') {
  format.value = f
  const cur = props.modelValue ?? (parseColor(input.value) ? toHex(parseColor(input.value)!) : null)
  input.value = cur ? (f === 'hex' ? cur : toRgba(parseHex(cur) ?? { r: 0, g: 0, b: 0, a: 1 })) : ''
  invalid.value = false
}

function applyInput() {
  const p = parseColor(input.value)
  if (!p) {
    invalid.value = true
    return
  }
  invalid.value = false
  emit('update:modelValue', toHex(p))
  input.value = format.value === 'hex' ? toHex(p) : toRgba(p)
}

function onPicker(v?: string) {
  emit('update:modelValue', v)
  if (v) input.value = format.value === 'hex' ? v : toRgba(parseHex(v) ?? { r: 0, g: 0, b: 0, a: 1 })
  invalid.value = false
}

const pickerModel = computed({
  get: () => props.modelValue ?? '',
  set: (v: string) => onPicker(v || undefined)
})

watch(open, (o) => { if (o) syncInput() })
watch(() => props.modelValue, () => { if (open.value) syncInput() })
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      label="选择颜色"
      color="neutral"
      variant="outline"
      size="sm"
    >
      <template #leading>
        <span
          :style="{ backgroundColor: modelValue ?? 'transparent' }"
          class="size-3 rounded-full border border-current/20"
        />
      </template>
    </UButton>

    <template #content>
      <div class="w-64 p-2">
        <UColorPicker v-model="pickerModel" />
        <div class="mt-2 flex items-center gap-2">
          <USegmented
            v-model="format"
            :items="formatItems"
            size="xs"
            class="shrink-0"
          />
          <UInput
            v-model="input"
            size="sm"
            class="flex-1"
            placeholder="如 #1a2b3c 或 rgba(…) 或 26,43,60,0.8"
            :color="invalid ? 'error' : undefined"
            @keyup.enter="applyInput"
            @blur="applyInput"
          />
        </div>
        <p
          v-if="invalid"
          class="mt-1.5 text-[11px] text-red-500"
        >
          格式无效,支持 #hex(3/4/6/8 位) 或 rgb()/rgba()/r,g,b,a
        </p>
      </div>
    </template>
  </UPopover>
</template>