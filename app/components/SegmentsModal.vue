<script setup lang="ts">
// 分段查看 / 正文编辑弹窗(docs/format-v2.md §3):v2(book2)作品专属。
// 左侧段列表(时间点/主角/细纲摘要),右侧正典(标题/主角/cast/节点/正文)+ 该段角色文件(状态/剧情/自由区)。
// 「编辑正文」直接改该段正典 text(段即真相,§2.1 归档全文不被引用不修改)。
// 入口:书架 v2 作品「更多操作」→「分段 / 正文」。
import { loadBook2, updateBook2 } from '../utils/bookStoreV2'
import type { BookDoc, SegmentDir } from '#shared/novel-v2'

const props = defineProps<{ workId: string }>()

const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const doc = ref<BookDoc | null>(null)
const loaded = ref(false)
const loadErr = ref('')
const saving = ref(false)
const selIdx = ref(0)

const segs = computed<SegmentDir[]>(() =>
  doc.value ? Object.values(doc.value.segments).sort((a, b) => a.canon.index - b.canon.index) : [])
const sel = computed(() => segs.value[selIdx.value] ?? null)
const selKey = computed(() => {
  if (!doc.value || !sel.value) return ''
  const entry = Object.entries(doc.value.segments).find(([, s]) => s === sel.value)
  return entry?.[0] ?? ''
})

watch(open, async (v) => {
  if (!v) return
  loaded.value = false
  loadErr.value = ''
  selIdx.value = 0
  editingText.value = false
  doc.value = await loadBook2(props.workId)
  if (!doc.value) loadErr.value = '该作品不是 v2(book2)作品,无法分段查看'
  loaded.value = true
})

/** 段标题:转折标题优先,回退 段序 */
function segTitle(seg: SegmentDir, i: number): string {
  return seg.canon.title?.trim() || `第${i + 1}段`
}

// ---- 正文编辑(段正典 text;保存写回 book2 zip,归档全文不维护,见 §2.1) ----
const editingText = ref(false)
const textDraft = ref('')

function beginEditText() {
  if (!sel.value) return
  textDraft.value = sel.value.canon.text
  editingText.value = true
}

async function saveText() {
  if (!sel.value || saving.value) return
  saving.value = true
  try {
    const key = selKey.value
    const text = textDraft.value
    if (!key) throw new Error('段定位丢失')
    await updateBook2(props.workId, (d) => {
      const seg = d.segments[key]
      if (!seg) throw new Error('本地 v2 数据中找不到该段')
      seg.canon.text = text
      return true
    })
    doc.value = await loadBook2(props.workId)
    editingText.value = false
    toast.add({ title: '本段正文已更新', color: 'success' })
  } catch (e) {
    toast.add({ title: '保存失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

const charEntries = computed(() =>
  sel.value ? Object.entries(sel.value.characters) : [])
</script>

<template>
  <UModal
    v-model:open="open"
    title="分段 / 正文"
    description="作品格式 v2:每段时间点一份正典,出场角色各有本段状态与剧情;正文按段编辑,段即真相"
    :ui="{ content: 'sm:max-w-4xl' }"
  >
    <template #body>
      <div
        v-if="!loaded"
        class="flex items-center justify-center gap-2 py-12 text-sm text-neutral-500"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin"
        />
        正在加载分段数据…
      </div>
      <UAlert
        v-else-if="loadErr"
        color="error"
        variant="soft"
        :title="loadErr"
      />
      <div
        v-else
        class="flex flex-col gap-4 sm:flex-row"
      >
        <!-- 段列表 -->
        <div class="flex shrink-0 gap-1.5 overflow-x-auto pb-1 sm:w-52 sm:flex-col sm:overflow-y-auto sm:pb-0 sm:pr-1 sm:max-h-[65vh]">
          <button
            v-for="(seg, i) in segs"
            :key="i"
            type="button"
            class="shrink-0 rounded-lg border px-2.5 py-1.5 text-left text-sm transition sm:w-full"
            :class="i === selIdx
              ? 'border-primary-500/60 bg-primary-500/10 text-primary-600 dark:text-primary-400'
              : 'border-(--ui-border) hover:border-primary-400/50'"
            @click="selIdx = i; editingText = false"
          >
            <span class="block truncate font-medium">{{ segTitle(seg, i) }}</span>
            <span class="block truncate text-[11px] text-neutral-400">{{ seg.canon.beat || `第${i + 1}段时间点` }}</span>
          </button>
        </div>

        <!-- 右侧详情 -->
        <div
          v-if="sel"
          class="min-w-0 flex-1 space-y-4 sm:max-h-[65vh] sm:overflow-y-auto sm:pr-1"
        >
          <!-- 正典 -->
          <section class="rounded-xl border border-neutral-200 p-3.5 dark:border-neutral-700">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-sm font-semibold">
                正典 · {{ segTitle(sel, selIdx) }}
              </h3>
              <UButton
                v-if="!editingText"
                label="编辑正文"
                icon="i-lucide-pencil"
                size="xs"
                color="neutral"
                variant="soft"
                @click="beginEditText"
              />
              <template v-else>
                <div class="flex gap-1.5">
                  <UButton
                    label="取消"
                    size="xs"
                    color="neutral"
                    variant="soft"
                    :disabled="saving"
                    @click="editingText = false"
                  />
                  <UButton
                    label="保存正文"
                    icon="i-lucide-save"
                    size="xs"
                    color="primary"
                    :loading="saving"
                    @click="saveText"
                  />
                </div>
              </template>
            </div>

            <div class="mb-2.5 space-y-1.5">
              <div
                v-if="sel.canon.主角?.length"
                class="flex items-baseline gap-2 text-xs"
              >
                <span class="min-w-16 shrink-0 text-neutral-500">叙事主角</span>
                <span>{{ sel.canon.主角.join('、') }}</span>
              </div>
              <div
                v-if="sel.canon.cast?.length"
                class="flex items-baseline gap-2 text-xs"
              >
                <span class="min-w-16 shrink-0 text-neutral-500">出场人物</span>
                <span>{{ sel.canon.cast.join('、') }}</span>
              </div>
              <div
                v-if="sel.canon.place"
                class="flex items-baseline gap-2 text-xs"
              >
                <span class="min-w-16 shrink-0 text-neutral-500">场景</span>
                <span>{{ sel.canon.place }}</span>
              </div>
              <div
                v-if="sel.canon.beat"
                class="flex items-baseline gap-2 text-xs"
              >
                <span class="min-w-16 shrink-0 text-neutral-500">细纲</span>
                <span class="min-w-0 flex-1">{{ sel.canon.beat }}</span>
              </div>
              <div
                v-if="sel.canon.hook"
                class="flex items-baseline gap-2 text-xs"
              >
                <span class="min-w-16 shrink-0 text-neutral-500">钩子</span>
                <span class="min-w-0 flex-1">{{ sel.canon.hook }}</span>
              </div>
            </div>

            <!-- 节点(事件里程碑) -->
            <div
              v-if="sel.canon.节点?.length"
              class="mb-2.5"
            >
              <p class="mb-1 text-xs font-semibold text-neutral-500">
                剧情里程碑 · {{ sel.canon.节点.length }} 个
              </p>
              <ol class="space-y-0.5 text-xs text-neutral-600 dark:text-neutral-400">
                <li
                  v-for="n in sel.canon.节点"
                  :key="n.n"
                >
                  {{ n.n + 1 }}. {{ n.事件 }}
                </li>
              </ol>
            </div>

            <!-- 正文(浏览/编辑) -->
            <div>
              <p class="mb-1 text-xs font-semibold text-neutral-500">
                正文
              </p>
              <UTextarea
                v-if="editingText"
                v-model="textDraft"
                autoresize
                :rows="10"
                class="w-full font-mono text-xs"
              />
              <p
                v-else
                class="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-2.5 text-sm leading-relaxed dark:bg-neutral-800/60"
              >
                {{ sel.canon.text || '(本段无正文)' }}
              </p>
            </div>
          </section>

          <!-- 该段角色文件 -->
          <section class="space-y-2">
            <h3 class="text-sm font-semibold">
              本段角色 · {{ charEntries.length }} 人
            </h3>
            <p class="text-xs text-neutral-400">
              仅列出本段建有文件(有状态/剧情)的角色;仅出场无内容的角色留在正典 cast 里(§3.2)
            </p>
            <div
              v-for="[name, file] in charEntries"
              :key="name"
              class="rounded-xl border border-neutral-200 p-3.5 dark:border-neutral-700"
            >
              <BookCharacterView :char="file" />
            </div>
            <p
              v-if="charEntries.length === 0"
              class="text-xs text-neutral-400"
            >
              本段没有角色分线文件
            </p>
          </section>
        </div>
      </div>
    </template>

    <template #footer>
      <UButton
        label="关闭"
        color="neutral"
        variant="soft"
        block
        @click="open = false"
      />
    </template>
  </UModal>
</template>
