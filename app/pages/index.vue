<script setup lang="ts">
// 首页:上传小说入口。上传 → POST /api/novels(SSE 流式)→ 实时 token 计数 → 解析完成后展示世界观速览 + 详细人物卡
useHead({ title: 'AI StoryBound · 上传小说' })

interface CharacterCard {
  name: string
  role: string
  alias?: string | null
  gender?: string | null
  age?: string | null
  identity?: string | null
  appearance?: string | null
  personality?: string[]
  speech_style?: string[]
  background?: string | null
  abilities?: string[]
  goals?: string[]
  fears?: string[]
  secrets?: string[]
  relationships?: { name: string, type: string, value: number }[]
  first_appearance?: string | null
  dead?: boolean | null
  patience?: number | null
  softness?: number | null
}
interface WorldOverlay {
  title?: string
  genre?: string
  summary?: string
  characters?: CharacterCard[]
}
interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}
interface NovelResult {
  id: string
  title: string
  encoding: string
  status: string
  chapter_count: number
}

const fileInput = ref<HTMLInputElement | null>(null)
const selected = ref<File | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const error = ref<string | null>(null)
const result = ref<NovelResult | null>(null)
const world = ref<WorldOverlay | null>(null)
const progress = ref(0)
const tokens = ref(0)        // 实时累计 token 估算
const speed = ref(0)         // tokens/秒
const usage = ref<TokenUsage | null>(null)
const elapsedMs = ref(0)
const savedLocal = ref(false)

function onPick(files?: FileList | null) {
  const f = files?.[0]
  if (f && /\.(txt|text)$/i.test(f.name)) {
    selected.value = f
    error.value = null
    result.value = null
    world.value = null
  } else if (f) {
    error.value = '仅支持 .txt 文本文件'
    selected.value = null
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false
  onPick(e.dataTransfer?.files)
}

function roleColor(role?: string) {
  if (role === '主角') return 'primary' as const
  if (role === '反派') return 'error' as const
  return 'neutral' as const
}

function fmtTokens(n?: number) {
  return n?.toLocaleString() ?? '—'
}

function fmtTime(ms: number) {
  return `${(ms / 1000).toFixed(1)} s`
}

async function upload() {
  if (!selected.value || uploading.value) return
  uploading.value = true
  error.value = null
  result.value = null
  world.value = null
  usage.value = null
  tokens.value = 0
  speed.value = 0
  elapsedMs.value = 0
  progress.value = 5

  const fd = new FormData()
  fd.append('file', selected.value)

  try {
    const res = await fetch('/api/novels', { method: 'POST', body: fd })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(text ? text.slice(0, 200) : `上传失败 (${res.status})`)
    }

    await readSseStream(res, (ev) => {
      switch (ev.name) {
        case 'progress':
          progress.value = Number(ev.payload.progress ?? progress.value)
          break
        case 'token':
          tokens.value = Number(ev.payload.tokens ?? 0)
          speed.value = Number(ev.payload.speed ?? 0)
          elapsedMs.value = Number(ev.payload.elapsedMs ?? 0)
          break
        case 'world':
          world.value = ev.payload.world as WorldOverlay
          break
        case 'done':
          result.value = {
            id: String(ev.payload.id ?? ''),
            title: String(ev.payload.title ?? ''),
            encoding: String(ev.payload.encoding ?? ''),
            status: String(ev.payload.status ?? 'ready'),
            chapter_count: Number(ev.payload.chapter_count ?? 0)
          }
          usage.value = ev.payload.usage ? (ev.payload.usage as TokenUsage) : null
          elapsedMs.value = Number(ev.payload.elapsedMs ?? 0)
          progress.value = 100
          // 人物卡保存到浏览器本地(IndexedDB),作为"我的世界"本地库
          if (world.value) {
            void saveWorld({
              novelId: String(ev.payload.id ?? ''),
              title: world.value.title ?? String(ev.payload.title ?? ''),
              genre: world.value.genre,
              summary: world.value.summary,
              characters: world.value.characters ?? [],
              savedAt: new Date().toISOString()
            }).then(() => { savedLocal.value = true }).catch((e) => { console.error('[saveWorld] failed:', e) })
          }
          break
        case 'error':
          throw new Error(String(ev.payload.message ?? '生成失败'))
      }
    })

    if (!result.value) throw new Error('生成未返回结果,请重试')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="min-h-[92vh] flex items-center justify-center px-4 py-12">
    <div class="w-full max-w-3xl space-y-6">
      <div class="text-center space-y-2">
        <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">
          AI StoryBound
        </h1>
        <p class="text-lg text-neutral-500 dark:text-neutral-400">
          上传一本小说，选择一个身份，走进故事，亲手改变原本的结局。
        </p>
      </div>

      <UCard>
        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
          :icon="'i-lucide-triangle-alert'"
          class="mb-4"
        />

        <!-- 选择区 -->
        <div
          v-if="!result && !uploading"
          class="flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-8 text-center transition-colors"
          :class="dragging ? 'border-primary-400 bg-primary-50 dark:bg-primary-500/10' : 'border-neutral-300 dark:border-neutral-700'"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            accept=".txt,.text,text/plain"
            @change="onPick(($event.target as HTMLInputElement).files)"
          >
          <UIcon
            name="i-lucide-book-open"
            class="size-10 text-neutral-400"
          />
          <div class="space-y-1">
            <p
              v-if="!selected"
              class="text-sm text-neutral-500 dark:text-neutral-400"
            >
              拖拽 TXT 到此处，或
              <UButton
                label="选择文件"
                size="xs"
                color="neutral"
                variant="soft"
                @click="fileInput?.click()"
              />
            </p>
            <p
              v-else
              class="text-sm font-medium"
            >
              {{ selected.name }}
            </p>
            <p
              v-if="selected"
              class="text-xs text-neutral-400"
            >
              {{ (selected.size / 1024).toFixed(1) }} KB
              <UButton
                label="重新选择"
                size="xs"
                variant="link"
                @click="fileInput?.click()"
              />
            </p>
          </div>

          <UButton
            icon="i-lucide-rocket"
            color="primary"
            @click="upload"
          >
            上传并生成故事
          </UButton>
        </div>

        <!-- 生成中(SSE 流式,实时进度 + token 计数) -->
        <div
          v-else-if="uploading"
          class="space-y-4 px-2 py-4"
        >
          <div class="flex items-center justify-between gap-3 text-sm">
            <div class="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
              <UIcon
                name="i-lucide-loader-circle"
                class="size-4 animate-spin"
              />
              <span>正在生成世界观与人物卡…</span>
            </div>
            <span class="truncate text-xs text-neutral-400">{{ selected?.name }}</span>
          </div>

          <UProgress
            :value="progress"
            class="w-full"
          />

          <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              已消耗 ≈
              <b class="tabular-nums font-semibold">{{ tokens }}</b>
              tokens
            </span>
            <span>
              生成速度
              <b class="tabular-nums font-semibold">{{ speed }}</b>
              tokens/s
            </span>
            <span v-if="elapsedMs">已耗时 {{ fmtTime(elapsedMs) }}</span>
          </div>
        </div>

        <!-- 结果展示 -->
        <div
          v-else
          class="space-y-5"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-xl font-semibold">
                {{ world?.title || result?.title }}
              </h2>
              <p class="text-sm text-neutral-500">
                {{ world?.genre || '未知题材' }} · {{ result?.chapter_count }} 章 · {{ result?.encoding.toUpperCase() }} 编码
              </p>
            </div>
            <div class="flex items-center gap-2">
              <UBadge
                v-if="savedLocal"
                color="info"
                variant="soft"
                label="已保存到本地"
              />
              <UBadge
                color="success"
                variant="soft"
                label="解析完成"
              />
            </div>
          </div>

          <div
            v-if="usage"
            class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-700"
          >
            <span>
              本次消耗
              <b class="tabular-nums font-semibold text-neutral-700 dark:text-neutral-200">{{ fmtTokens(usage.totalTokens) }}</b>
              tokens
            </span>
            <template v-if="usage.promptTokens !== undefined">
              <span>prompt {{ fmtTokens(usage.promptTokens) }}</span>
            </template>
            <template v-if="usage.completionTokens !== undefined">
              <span>completion {{ fmtTokens(usage.completionTokens) }}</span>
            </template>
            <span>耗时 {{ fmtTime(elapsedMs) }}</span>
          </div>

          <p
            v-if="world?.summary"
            class="text-sm text-neutral-600 dark:text-neutral-300"
          >
            {{ world.summary }}
          </p>

          <!-- 人物卡 -->
          <div v-if="world?.characters?.length">
            <p class="mb-3 text-sm font-medium">
              人物卡（{{ world.characters.length }}）
            </p>
            <div class="grid gap-4 sm:grid-cols-2">
              <UCard
                v-for="c in world.characters"
                :key="c.name"
                class="space-y-3"
              >
                <div class="flex items-center gap-3">
                  <div class="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-500/10 text-base font-semibold text-primary-500">
                    {{ (c.name || '?').slice(0, 1) }}
                  </div>
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="font-semibold">{{ c.name }}</span>
                      <UBadge
                        :color="roleColor(c.role)"
                        variant="subtle"
                        :label="c.role"
                      />
                      <UBadge
                        v-if="c.dead"
                        color="error"
                        variant="soft"
                        label="已死亡"
                      />
                    </div>
                    <p class="truncate text-xs text-neutral-500">
                      {{ [c.identity, c.gender, c.age].filter(Boolean).join(' · ') || '未知身份' }}
                    </p>
                    <p
                      v-if="c.patience != null || c.softness != null"
                      class="text-xs text-neutral-500"
                    >
                      耐心 {{ c.patience ?? '—' }} · 心软 {{ c.softness ?? '—' }}
                    </p>
                  </div>
                </div>

                <div
                  v-if="c.personality?.length"
                  class="flex flex-wrap gap-1.5"
                >
                  <UBadge
                    v-for="t in c.personality"
                    :key="t"
                    color="neutral"
                    variant="soft"
                    :label="t"
                  />
                </div>

                <div class="space-y-2 text-sm">
                  <template v-if="c.alias">
                    <p class="text-xs text-neutral-500">
                      别名：{{ c.alias }}
                    </p>
                  </template>
                  <template v-if="c.first_appearance">
                    <p class="text-xs text-neutral-500">
                      首次登场：{{ c.first_appearance }}
                    </p>
                  </template>
                  <div v-if="c.appearance">
                    <p class="text-xs font-medium text-neutral-500">
                      外貌
                    </p>
                    <p class="text-neutral-600 dark:text-neutral-300">
                      {{ c.appearance }}
                    </p>
                  </div>
                  <div v-if="c.background">
                    <p class="text-xs font-medium text-neutral-500">
                      背景
                    </p>
                    <p class="text-neutral-600 dark:text-neutral-300">
                      {{ c.background }}
                    </p>
                  </div>
                  <div v-if="c.abilities?.length">
                    <p class="text-xs font-medium text-neutral-500">
                      能力
                    </p>
                    <p class="text-neutral-600 dark:text-neutral-300">
                      {{ c.abilities.join('、') }}
                    </p>
                  </div>
                  <div v-if="c.goals?.length">
                    <p class="text-xs font-medium text-neutral-500">
                      目标
                    </p>
                    <p class="text-neutral-600 dark:text-neutral-300">
                      {{ c.goals.join('、') }}
                    </p>
                  </div>
                  <div v-if="c.fears?.length">
                    <p class="text-xs font-medium text-neutral-500">
                      恐惧 / 弱点
                    </p>
                    <p class="text-neutral-600 dark:text-neutral-300">
                      {{ c.fears.join('、') }}
                    </p>
                  </div>
                  <div v-if="c.secrets?.length">
                    <p class="text-xs font-medium text-neutral-500">
                      秘密
                    </p>
                    <p class="text-neutral-600 dark:text-neutral-300">
                      {{ c.secrets.join('、') }}
                    </p>
                  </div>
                  <div v-if="c.speech_style?.length">
                    <p class="text-xs font-medium text-neutral-500">
                      说话风格
                    </p>
                    <p class="text-neutral-600 dark:text-neutral-300">
                      {{ c.speech_style.join('、') }}
                    </p>
                  </div>
                  <div v-if="c.relationships?.length">
                    <p class="text-xs font-medium text-neutral-500">
                      人物关系
                    </p>
                    <ul class="space-y-0.5 text-neutral-600 dark:text-neutral-300">
                      <li
                        v-for="(r, i) in c.relationships"
                        :key="`${r.name}-${i}`"
                      >
                        {{ r.name }}（{{ r.type }}{{ r.value !== undefined ? ` · ${r.value}` : '' }}）
                      </li>
                    </ul>
                  </div>
                </div>
              </UCard>
            </div>
          </div>

          <div class="flex gap-2 pt-1">
            <UButton
              label="选择角色，进入故事"
              color="primary"
              icon="i-lucide-play"
              :to="`/novels/${result?.id}/select`"
            />
            <UButton
              label="上传另一本"
              color="neutral"
              variant="outline"
              @click="result = null; world = null; selected = null; usage = null"
            />
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
