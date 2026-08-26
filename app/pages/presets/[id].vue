<script setup lang="ts">
// 预置小说预览/阅读页:
// - 挂载时先查 IndexedDB 缓存,未命中则从 /api/presets/[id]/download 下载全文并写入 IndexedDB(持久化,可离线阅读)
// - 章节切分复用 shared/novel 的 segmentChapters(浏览器端可用)
// - "用这本小说生成世界" → 跳转 /generate?from=preset&id=xxx:由生成页自动加载本小说为附件,进入确认页由用户确认
import { segmentChapters } from '../../utils/chapters'
import type { PresetNovelRow, ChapterSegment } from '#shared/novel'
import { useAuthModal } from '~/composables/useAuthModal'

const { requireLogin } = useAuthModal()

const route = useRoute()
const id = String(route.params.id)

// 元数据(SSR 拉取;失败时回退到本地缓存的 meta)
const { data: preset } = await useFetch<PresetNovelRow>(`/api/presets/${id}`, { watch: false })

const cachedMeta = ref<PresetNovelRow | null>(null)
const meta = computed<PresetNovelRow | null>(() => preset.value ?? cachedMeta.value)

// ---- 全文加载/缓存 ----
const textState = ref<'loading' | 'ready' | 'error'>('loading')
const textError = ref<string | null>(null)
const cachedAt = ref<string | null>(null)
const chapters = ref<ChapterSegment[]>([])
const current = ref(0)

function chapLabel(i: number) {
  const ch = chapters.value[i]
  if (!ch) return ''
  return ch.title || (i === 0 ? '前言' : `第 ${i + 1} 部分`)
}

function applyText(raw: string) {
  const clean = raw.replace(/^\uFEFF/, '') // 去 BOM
  chapters.value = segmentChapters(clean)
  textState.value = chapters.value.length > 0 ? 'ready' : 'error'
  if (textState.value === 'error') textError.value = '文本解析失败(无可读章节)'
}

async function loadText() {
  try {
    const cached = await getCachedPreset(id)
    if (cached) {
      cachedAt.value = cached.savedAt
      if (!cachedMeta.value) cachedMeta.value = cached.meta as unknown as PresetNovelRow
      applyText(cached.text)
      return
    }
  } catch (e) {
    console.error('[preset cache] read failed:', e)
  }

  try {
    const res = await fetch(`/api/presets/${id}/download`)
    if (!res.ok) throw new Error(`下载失败 (${res.status})`)
    const text = await res.text()
    applyText(text)
    // 写入 IndexedDB 持久化(失败不阻塞阅读)
    void saveCachedPreset(meta.value ?? { id, title: id, author: null, genre: null, description: null, cover_emoji: null }, text)
      .then(() => { cachedAt.value = new Date().toISOString() })
      .catch((e) => { console.error('[preset cache] save failed:', e) })
  } catch (e) {
    textState.value = 'error'
    textError.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(loadText)

// ---- 用这本小说生成世界:跳转生成页自动带上本小说,由用户确认后再生成;生成模式(完整/节约)在生成页选择 ----
async function goGenerateWithNovel() {
  if (textState.value !== 'ready') return // 全文未就绪(加载中/失败)时不跳转
  // 生成需要登录:未登录弹出全局登录模态框,登录成功后继续
  const ok = await requireLogin()
  if (!ok) return
  // 小说全文由生成页按同一来源加载(IndexedDB 缓存优先,未命中下载),这里只传来源
  const q = new URLSearchParams({ from: 'preset', id })
  await navigateTo(`/generate?${q.toString()}`)
}

function fmtChars(n?: number) {
  if (!n || n <= 0) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`
  if (n >= 1000) return `${(n / 1000).toFixed(1)} 千字`
  return `${n} 字`
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-4 py-8">
    <div class="space-y-6">
      <!-- 404 / 无数据 -->
      <div
        v-if="!meta"
        class="space-y-4 py-16 text-center"
      >
        <UIcon
          name="i-lucide-book-x"
          class="mx-auto size-12 text-neutral-400"
        />
        <UAlert
          color="error"
          variant="soft"
          icon="i-lucide-triangle-alert"
          title="预置小说不存在或已下架"
        />
        <UButton
          label="返回首页"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :to="'/'"
        />
      </div>

      <template v-else>
        <!-- 头部 -->
        <div class="flex flex-col gap-4 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-700 sm:flex-row sm:items-start">
          <div class="flex items-center gap-3">
            <div
              class="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-primary-500/15 text-4xl text-primary-600 dark:text-primary-400"
            >
              <span>{{ meta.cover_emoji || '📖' }}</span>
            </div>
            <div class="min-w-0">
              <h1 class="truncate text-2xl font-bold tracking-tight">
                {{ meta.title }}
              </h1>
              <div class="mt-1 flex flex-wrap items-center gap-2">
                <UBadge
                  variant="subtle"
                  :label="`${meta.chapter_count ?? 0} 章 · ${fmtChars(meta.char_count ?? 0)}`"
                />
                <UBadge
                  v-if="cachedAt"
                  color="info"
                  variant="soft"
                  icon="i-lucide-hard-drive"
                  label="已缓存到本地"
                />
              </div>
            </div>
          </div>
          <div class="flex flex-col gap-2 sm:ml-auto sm:items-end">
            <UButton
              label="用这本小说生成世界"
              color="primary"
              icon="i-lucide-sparkles"
              :disabled="textState !== 'ready'"
              @click="goGenerateWithNovel"
            />
            <div class="flex items-center gap-2">
              <UButton
                label="沉浸式阅读"
                color="primary"
                variant="soft"
                icon="i-lucide-book-open"
                :to="`/read/preset/${id}`"
              />
              <UButton
                label="下载 TXT"
                color="neutral"
                variant="outline"
                icon="i-lucide-download"
                :to="`/api/presets/${id}/download`"
                target="_blank"
              />
            </div>
          </div>
          </div>

        <!-- 阅读区 -->
        <div
          v-if="textState === 'loading'"
          class="space-y-3"
        >
          <USkeleton class="h-8 w-1/3" />
          <USkeleton class="h-4 w-full" />
          <USkeleton class="h-4 w-11/12" />
          <USkeleton class="h-4 w-full" />
          <USkeleton class="h-4 w-2/3" />
        </div>

        <div
          v-else-if="textState === 'error'"
          class="space-y-4 py-8 text-center"
        >
          <UAlert
            color="error"
            variant="soft"
            icon="i-lucide-triangle-alert"
            :title="textError ?? '内容加载失败'"
          />
          <UButton
            label="重新加载"
            color="primary"
            variant="outline"
            icon="i-lucide-refresh-cw"
            @click="textState = 'loading'; loadText()"
          />
        </div>

        <div
          v-else
          class="grid gap-6 lg:grid-cols-[260px_1fr]"
        >
          <!-- 章节侧栏(大屏) -->
          <aside class="hidden max-h-[75vh] overflow-y-auto rounded-2xl border border-neutral-200 p-2 dark:border-neutral-700 lg:block">
            <nav class="space-y-0.5">
              <button
                v-for="(ch, i) in chapters"
                :key="i"
                type="button"
                class="block w-full truncate rounded-lg px-3 py-1.5 text-left text-sm transition-colors"
                :class="i === current
                  ? 'bg-primary-500/10 font-medium text-primary-600 dark:text-primary-400'
                  : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'"
                @click="current = i"
              >
                {{ chapLabel(i) }}
              </button>
            </nav>
          </aside>

          <!-- 正文 -->
          <article class="min-w-0 space-y-4">
            <div class="flex items-center gap-3">
              <!-- 章节选择(小屏) -->
              <USelect
                v-model="current"
                class="w-full lg:hidden"
                :items="chapters.map((_, i) => ({ label: chapLabel(i), value: i }))"
                value-key="value"
                label-key="label"
              />
              <h2 class="hidden truncate text-lg font-semibold lg:block">
                {{ chapLabel(current) }}
              </h2>
              <span class="ml-auto hidden shrink-0 text-xs text-neutral-400 lg:block">
                {{ current + 1 }} / {{ chapters.length }}
              </span>
            </div>

            <div class="space-y-4 rounded-2xl border border-neutral-200 p-6 leading-8 dark:border-neutral-700 sm:px-8">
              <p class="whitespace-pre-wrap text-[15px] text-neutral-800 dark:text-neutral-200">
                {{ chapters[current]?.content }}
              </p>
            </div>

            <div class="flex items-center justify-between gap-3">
              <UButton
                label="上一章"
                color="neutral"
                variant="outline"
                icon="i-lucide-arrow-left"
                :disabled="current <= 0"
                @click="current--"
              />
              <span class="text-xs text-neutral-400 lg:hidden">
                {{ current + 1 }} / {{ chapters.length }}
              </span>
              <UButton
                label="下一章"
                color="neutral"
                variant="outline"
                icon="i-lucide-arrow-right"
                trailing
                :disabled="current >= chapters.length - 1"
                @click="current++"
              />
            </div>
          </article>
        </div>
      </template>
    </div>
  </div>
</template>
