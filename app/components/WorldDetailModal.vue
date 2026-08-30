<script setup lang="ts">
// 世界详情弹窗:展示本地作品的完整生成产物(概览元数据/故事线/实体库/冲突/生成告警),
// 并提供概览元数据(summary/性向/尺度/设定/tags 等)的编辑——此前这些字段生成后全应用不可见、不可改。
// 入口:书架卡片「世界详情」/ 生成完成页 / 选角页;保存后由父组件刷新列表。
import { getWork, saveWork } from '../utils/worldGen'
import type { LocalWork, WorldEntities, EntityConflict, StoryBeat } from '#shared/novel'

const props = defineProps<{ workId: string }>()
const emit = defineEmits<{ saved: [] }>()

const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const work = ref<LocalWork | null>(null)
const loaded = ref(false)
const loadErr = ref('')
const editing = ref(false)
const saving = ref(false)

const HEAT_OPTS = ['淡', '中', '烈'] as const

/** 概览元数据编辑草稿(数组字段用逗号分隔字符串编辑) */
const draft = ref({
  summary: '',
  genre: '',
  orientation: '',
  setting: '',
  heat: '',
  tags: '',
  tropes: '',
  contentWarnings: ''
})

function joinList(list: string[] | undefined): string {
  return (list ?? []).join('、')
}

function splitList(v: string): string[] {
  return v.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean)
}

watch(open, async (v) => {
  if (!v) return
  editing.value = false
  saving.value = false
  loaded.value = false
  loadErr.value = ''
  const w = await getWork(props.workId)
  if (!w) {
    loadErr.value = '本地未找到该作品'
    loaded.value = true
    return
  }
  work.value = w
  loaded.value = true
})

function beginEdit() {
  const o = work.value?.overlay
  draft.value = {
    summary: o?.summary ?? '',
    genre: o?.genre ?? '',
    orientation: o?.orientation ?? '',
    setting: o?.setting ?? '',
    heat: o?.heat ?? '',
    tags: joinList(o?.tags),
    tropes: joinList(o?.tropes),
    contentWarnings: joinList(o?.contentWarnings)
  }
  editing.value = true
}

async function saveMeta() {
  if (!work.value || saving.value) return
  saving.value = true
  try {
    const o = { ...(work.value.overlay ?? {}) }
    o.summary = draft.value.summary.trim() || undefined
    o.genre = draft.value.genre.trim() || undefined
    o.orientation = draft.value.orientation.trim() || undefined
    o.setting = draft.value.setting.trim() || undefined
    const heat = draft.value.heat.trim()
    o.heat = (HEAT_OPTS as readonly string[]).includes(heat) ? (heat as typeof HEAT_OPTS[number]) : undefined
    const tags = splitList(draft.value.tags)
    o.tags = tags.length ? tags : undefined
    const tropes = splitList(draft.value.tropes)
    o.tropes = tropes.length ? tropes : undefined
    const cws = splitList(draft.value.contentWarnings)
    o.contentWarnings = cws.length ? cws : undefined
    work.value.overlay = o
    // 云端已有对应作品时标记待同步(由书架「同步云端」推送)
    if (work.value.syncStatus === 'synced') work.value.syncStatus = 'dirty'
    await saveWork(JSON.parse(JSON.stringify(work.value)))
    editing.value = false
    toast.add({ title: '世界概览已更新', color: 'success' })
    emit('saved')
  } catch (e) {
    toast.add({ title: '保存失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

// ---- 实体库展示(分组折叠) ----

interface EntityRow {
  title: string
  desc: string
  source: string
  verified: boolean
}

/** 原文引用来源摘要(取首条;quote 存在时标注校验结果) */
function srcBrief(sources: { chapter: number, quote?: string | null, verified?: boolean }[] | undefined): { text: string, verified: boolean } | null {
  const s = sources?.[0]
  if (!s) return null
  const quote = s.quote?.trim()
  return {
    text: `第${s.chapter}章${quote ? `「${quote.length > 40 ? `${quote.slice(0, 40)}…` : quote}」` : ''}`,
    verified: s.verified === true
  }
}

const entityGroups = computed(() => {
  const e: WorldEntities | undefined = work.value?.entities
  if (!e) return []
  const groups: { key: string, label: string, rows: EntityRow[] }[] = []
  const push = (key: string, label: string, rows: EntityRow[]) => {
    if (rows.length) groups.push({ key, label, rows })
  }
  push('characters', `人物 · ${e.characters.length}`, e.characters.map(c => ({
    title: `${c.name}${c.alias?.length ? `(${c.alias.join('/')})` : ''}`,
    desc: [c.gender, c.age ? `约${c.age}岁` : '', c.identity, c.appearance].filter(Boolean).join(' · '),
    source: srcBrief(c.sources)?.text ?? '',
    verified: srcBrief(c.sources)?.verified ?? false
  })))
  push('locations', `地点 · ${e.locations.length}`, e.locations.map(l => ({
    title: l.name,
    desc: [l.type, l.description].filter(Boolean).join(' · '),
    source: srcBrief(l.sources)?.text ?? '',
    verified: srcBrief(l.sources)?.verified ?? false
  })))
  push('factions', `势力 · ${e.factions.length}`, e.factions.map(f => ({
    title: f.name,
    desc: [f.description, f.goal ? `目标:${f.goal}` : ''].filter(Boolean).join(' · '),
    source: srcBrief(f.sources)?.text ?? '',
    verified: srcBrief(f.sources)?.verified ?? false
  })))
  push('rules', `世界规则 · ${e.world_rules.length}`, e.world_rules.map(r => ({
    title: r.category ?? '规则',
    desc: r.rule,
    source: srcBrief(r.sources)?.text ?? '',
    verified: srcBrief(r.sources)?.verified ?? false
  })))
  push('timeline', `时间线 · ${e.timeline_events.length}`, e.timeline_events.map(t => ({
    title: t.time ?? '—',
    desc: t.event,
    source: srcBrief(t.sources)?.text ?? '',
    verified: srcBrief(t.sources)?.verified ?? false
  })))
  push('items', `物品 · ${e.items.length}`, e.items.map(i => ({
    title: i.name,
    desc: [i.description, i.significance ? `意义:${i.significance}` : ''].filter(Boolean).join(' · '),
    source: srcBrief(i.sources)?.text ?? '',
    verified: srcBrief(i.sources)?.verified ?? false
  })))
  push('foreshadowing', `伏笔 · ${e.foreshadowing.length}`, e.foreshadowing.map(f => ({
    title: '伏笔',
    desc: f.hint,
    source: srcBrief(f.sources)?.text ?? '',
    verified: srcBrief(f.sources)?.verified ?? false
  })))
  return groups
})

const conflicts = computed<EntityConflict[]>(() => work.value?.conflicts ?? [])
const warnings = computed<string[]>(() => work.value?.warnings ?? [])
const storyline = computed<StoryBeat[]>(() => work.value?.storyline ?? [])

const VERDICT_LABEL: Record<string, string> = {
  later_wins: '以后文为准',
  first_wins: '以前文为准',
  uncertain: '存疑',
  not_conflict: '非冲突'
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="世界详情"
    description="生成产物总览:概览、故事线、实体库、冲突与告警"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <p
        v-if="loadErr"
        class="text-sm text-red-500"
      >
        {{ loadErr }}
      </p>
      <div
        v-else-if="!loaded"
        class="flex justify-center py-8"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-6 animate-spin text-neutral-300"
        />
      </div>
      <div
        v-else-if="work"
        class="space-y-4"
      >
        <!-- 概览 -->
        <section class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-sm font-semibold">
              世界概览
            </h3>
            <UButton
              v-if="!editing"
              label="编辑概览"
              icon="i-lucide-pencil"
              size="xs"
              color="neutral"
              variant="soft"
              @click="beginEdit"
            />
            <template v-else>
              <UButton
                label="保存"
                icon="i-lucide-save"
                size="xs"
                color="primary"
                :loading="saving"
                @click="saveMeta"
              />
            </template>
          </div>

          <!-- 浏览态 -->
          <div
            v-if="!editing"
            class="space-y-2 text-sm"
          >
            <p
              v-if="work.overlay?.summary"
              class="text-neutral-600 dark:text-neutral-300"
            >
              {{ work.overlay.summary }}
            </p>
            <p
              v-else
              class="text-neutral-400"
            >
              暂无简介
            </p>
            <div class="flex flex-wrap gap-1.5">
              <UBadge
                v-if="work.overlay?.orientation"
                color="info"
                variant="subtle"
                size="sm"
              >
                {{ work.overlay.orientation }}
              </UBadge>
              <UBadge
                v-if="work.overlay?.heat"
                color="warning"
                variant="subtle"
                size="sm"
              >
                尺度:{{ work.overlay.heat }}
              </UBadge>
              <UBadge
                v-for="tag in work.overlay?.tags ?? []"
                :key="tag"
                color="primary"
                variant="subtle"
                size="sm"
              >
                {{ tag }}
              </UBadge>
            </div>
            <p
              v-if="work.overlay?.setting"
              class="text-xs text-neutral-500"
            >
              <span class="font-medium">设定:</span>{{ work.overlay.setting }}
            </p>
            <p
              v-if="work.overlay?.contentWarnings?.length"
              class="text-xs text-amber-600 dark:text-amber-400"
            >
              <span class="font-medium">内容警告:</span>{{ work.overlay.contentWarnings.join('、') }}
            </p>
            <p
              v-if="work.overlay?.tropes?.length"
              class="text-xs text-neutral-500"
            >
              <span class="font-medium">剧情原型:</span>{{ work.overlay.tropes.join('、') }}
            </p>
          </div>

          <!-- 编辑态 -->
          <div
            v-else
            class="space-y-3"
          >
            <UFormField label="简介">
              <UTextarea
                v-model="draft.summary"
                :rows="3"
                class="w-full"
              />
            </UFormField>
            <div class="grid gap-3 sm:grid-cols-3">
              <UFormField label="类型">
                <UInput
                  v-model="draft.genre"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="性向">
                <UInput
                  v-model="draft.orientation"
                  placeholder="男女/女女/男男/混合"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="尺度">
                <USelect
                  v-model="draft.heat"
                  :items="[{ label: '未设置', value: '' }, ...HEAT_OPTS.map(h => ({ label: h, value: h }))]"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UFormField label="设定(舞台 + 体系一句话)">
              <UTextarea
                v-model="draft.setting"
                :rows="2"
                class="w-full"
              />
            </UFormField>
            <UFormField label="标签(顿号/逗号分隔)">
              <UTextarea
                v-model="draft.tags"
                :rows="2"
                class="w-full"
              />
            </UFormField>
            <UFormField label="内容警告(顿号/逗号分隔)">
              <UInput
                v-model="draft.contentWarnings"
                class="w-full"
              />
            </UFormField>
            <UFormField label="剧情原型(顿号/逗号分隔)">
              <UInput
                v-model="draft.tropes"
                class="w-full"
              />
            </UFormField>
          </div>
        </section>

        <!-- 故事线 -->
        <details
          v-if="storyline.length"
          class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-700"
        >
          <summary class="cursor-pointer text-sm font-semibold">
            故事线 · {{ storyline.length }} 段
          </summary>
          <ol class="mt-3 max-h-64 space-y-2 overflow-y-auto text-sm text-neutral-600 dark:text-neutral-400">
            <li
              v-for="beat in storyline"
              :key="beat.index"
            >
              <span class="font-medium text-highlighted">段{{ beat.index + 1 }}</span>
              {{ beat.summary }}
            </li>
          </ol>
        </details>

        <!-- 实体库 -->
        <section
          v-if="entityGroups.length"
          class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-700"
        >
          <h3 class="text-sm font-semibold">
            实体库
            <span class="ml-1 text-xs font-normal text-neutral-400">(带「✓」的来源已与正文逐字比对)</span>
          </h3>
          <div class="mt-2 space-y-2">
            <details
              v-for="g in entityGroups"
              :key="g.key"
            >
              <summary class="cursor-pointer text-xs font-medium text-neutral-600 dark:text-neutral-300">
                {{ g.label }}
              </summary>
              <ul class="mt-2 max-h-56 space-y-1.5 overflow-y-auto text-xs text-neutral-600 dark:text-neutral-400">
                <li
                  v-for="(row, i) in g.rows"
                  :key="i"
                  class="rounded-lg bg-neutral-50 p-2 dark:bg-neutral-800/60"
                >
                  <span class="font-medium">{{ row.title }}</span>
                  <span
                    v-if="row.desc"
                    class="ml-1"
                  >— {{ row.desc }}</span>
                  <span
                    v-if="row.source"
                    class="mt-0.5 block text-neutral-400"
                  >来源:{{ row.source }}
                    <template v-if="row.verified"><span class="text-emerald-500">✓ 已比对</span></template>
                    <template v-else><span class="text-amber-500">未逐字匹配</span></template>
                  </span>
                </li>
              </ul>
            </details>
          </div>
        </section>

        <!-- 冲突 -->
        <section
          v-if="conflicts.length"
          class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-700"
        >
          <h3 class="text-sm font-semibold">
            设定冲突 · {{ conflicts.length }}
          </h3>
          <ul class="mt-2 max-h-48 space-y-1.5 overflow-y-auto text-xs text-neutral-600 dark:text-neutral-400">
            <li
              v-for="c in conflicts"
              :key="c.id"
              class="rounded-lg bg-amber-50 p-2 dark:bg-amber-900/20"
            >
              <span class="font-medium">{{ c.entityName }}.{{ c.field }}</span>
              <template v-if="c.valueA != null || c.valueB != null">
                :「{{ c.valueA ?? '—' }}」 vs 「{{ c.valueB ?? '—' }}」
              </template>
              <UBadge
                v-if="c.verdict && c.verdict !== 'not_conflict'"
                :color="c.verdict === 'uncertain' ? 'warning' : 'neutral'"
                variant="subtle"
                size="sm"
                class="ml-1"
              >
                {{ VERDICT_LABEL[c.verdict] ?? c.verdict }}
              </UBadge>
              <span
                v-if="c.reason"
                class="mt-0.5 block text-neutral-400"
              >{{ c.reason }}</span>
            </li>
          </ul>
        </section>

        <!-- 生成告警 -->
        <section
          v-if="warnings.length"
          class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-700"
        >
          <h3 class="text-sm font-semibold">
            生成告警 · {{ warnings.length }}
          </h3>
          <ul class="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-amber-600 dark:text-amber-400">
            <li
              v-for="(w, i) in warnings"
              :key="i"
            >
              {{ w }}
            </li>
          </ul>
        </section>

        <p
          v-if="!entityGroups.length && !conflicts.length && !warnings.length && !storyline.length && !work.overlay?.summary"
          class="py-4 text-center text-sm text-neutral-400"
        >
          该作品还没有世界产物——到书架「重新生成世界」补齐
        </p>
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
