<script setup lang="ts">
// 通用键值渲染(docs/format-v2.md §7.1 自由键通用渲染):
// 字符串→文本;数组→标签/多行;数字→数字;布尔→是/否;对象→子分组缩进展开(不崩、可读)。
// 所有文本字段默认 1 行截断省略,点击展开/收起;结构与值形状无关,导入的异版本怪字段也按此渲染。
const props = withDefaults(defineProps<{
  /** 字段显示名(标签) */
  label: string
  value: unknown
  /** 是否允许折叠(默认 true;根级长文本建议开启) */
  collapsible?: boolean
  /** 缩进层级(对象递归子行用) */
  depth?: number
}>(), { collapsible: true, depth: 0 })

/** 超过该字数的文本默认折叠为 1 行省略 */
const FOLD_CHARS = 60

const text = computed(() => {
  const v = props.value
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
})

const listItems = computed(() => {
  const v = props.value
  if (Array.isArray(v)) return v.filter(x => x != null && typeof x !== 'object').map(x => String(x))
  return []
})

/** 对象/异构数组 → 子键值行(递归用) */
interface SubRow { label: string, value: unknown }
const subRows = computed<SubRow[]>(() => {
  const v = props.value
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v as Record<string, unknown>).map(([k, val]) => ({ label: k, value: val }))
  }
  if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) {
    // 对象数组:逐项折叠为「#序号」子分组
    return v.map((item, i) => ({ label: `#${i + 1}`, value: item }))
  }
  return []
})

const isObjectLike = computed(() => subRows.value.length > 0)
const isList = computed(() => !isObjectLike.value && listItems.value.length > 0)
const isEmpty = computed(() => !isObjectLike.value && !isList.value && text.value === '')

/** 单行文本超过阈值才可折叠 */
const foldable = computed(() =>
  props.collapsible && !isObjectLike.value && !isList.value && text.value.length > FOLD_CHARS)
const expanded = ref(false)
const displayText = computed(() =>
  foldable.value && !expanded.value ? `${text.value.slice(0, FOLD_CHARS)}…` : text.value)

const boolText = computed(() => (props.value === true ? '是' : props.value === false ? '否' : ''))
</script>

<template>
  <div
    class="min-w-0"
    :class="depth > 0 ? 'border-l border-neutral-200 pl-3 dark:border-neutral-700' : ''"
  >
    <div class="flex items-baseline gap-2">
      <span
        class="shrink-0 text-xs font-medium text-neutral-500 dark:text-neutral-400"
        :class="depth > 0 ? '' : 'min-w-20'"
      >{{ label }}</span>
      <!-- 对象:子行缩进展开 -->
      <div
        v-if="isObjectLike"
        class="min-w-0 flex-1 space-y-1"
      >
        <KeyValueView
          v-for="row in subRows"
          :key="row.label"
          :label="row.label"
          :value="row.value"
          :collapsible="collapsible"
          :depth="depth + 1"
        />
      </div>
      <!-- 数组:标签式 -->
      <div
        v-else-if="isList"
        class="flex min-w-0 flex-1 flex-wrap gap-1"
      >
        <UBadge
          v-for="(item, i) in listItems"
          :key="i"
          color="neutral"
          variant="subtle"
          size="sm"
          class="max-w-full font-normal"
        >
          <span class="break-all">{{ item }}</span>
        </UBadge>
      </div>
      <!-- 空:占位 -->
      <span
        v-else-if="isEmpty"
        class="text-xs text-neutral-400"
      >—</span>
      <!-- 标量文本(可折叠) -->
      <component
        :is="foldable ? 'button' : 'span'"
        v-else
        class="min-w-0 flex-1 text-left text-sm whitespace-pre-wrap break-words"
        :class="foldable ? 'cursor-pointer hover:text-highlighted' : ''"
        @click="foldable && (expanded = !expanded)"
      >
        {{ typeof value === 'boolean' ? boolText : displayText }}
      </component>
    </div>
  </div>
</template>
