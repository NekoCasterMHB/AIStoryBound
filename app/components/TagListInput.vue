<script setup lang="ts">
// 标签列表输入:回车/逗号添加标签,点 X 删除;空数组时显示占位提示
const props = defineProps<{ modelValue?: string[] | null, placeholder?: string }>()
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const model = computed({
  get: () => props.modelValue ?? [],
  set: (v: string[]) => emit('update:modelValue', v)
})

const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

function commit() {
  const v = draft.value.trim().replace(/[,，、]/g, '').trim()
  if (v && !model.value.includes(v)) model.value = [...model.value, v]
  draft.value = ''
}

function removeAt(i: number) {
  model.value = model.value.filter((_, idx) => idx !== i)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === '、') {
    e.preventDefault()
    commit()
  } else if (e.key === 'Backspace' && !draft.value && model.value.length) {
    removeAt(model.value.length - 1)
  }
}

defineExpose({ focus: () => inputEl.value?.focus() })
</script>

<template>
  <div class="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-(--ui-border) bg-(--ui-bg) px-2 py-1.5 focus-within:border-(--ui-primary)">
    <span
      v-for="(t, i) in model"
      :key="`${t}-${i}`"
      class="inline-flex items-center gap-1 rounded-full bg-primary-500/10 py-0.5 pl-2 pr-1 text-xs text-primary-600 dark:bg-primary-400/10 dark:text-primary-400"
    >
      {{ t }}
      <button
        type="button"
        class="flex size-4 items-center justify-center rounded-full hover:bg-primary-500/15"
        aria-label="删除标签"
        @click="removeAt(i)"
      >
        <UIcon
          name="i-lucide-x"
          class="size-3"
        />
      </button>
    </span>
    <input
      ref="inputEl"
      v-model="draft"
      type="text"
      class="min-w-20 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-(--ui-text-dimmed)"
      :placeholder="model.length ? '' : (placeholder || '回车添加')"
      @keydown="onKeydown"
      @blur="commit"
    >
  </div>
</template>
