<script setup lang="ts">
// 首页:上传小说入口。上传 → /api/novels 解析入库并与 LLM 生成世界观速览 → 展示结果
useHead({ title: 'AI StoryBound · 上传小说' })

interface WorldOverlay {
  title?: string
  genre?: string
  summary?: string
  characters?: { name: string, role: string, description: string }[]
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

async function upload() {
  if (!selected.value || uploading.value) return
  uploading.value = true
  error.value = null
  result.value = null
  world.value = null
  progress.value = 15

  const fd = new FormData()
  fd.append('file', selected.value)

  try {
    const { data, error: err } = await useFetch('/api/novels', {
      method: 'POST',
      body: fd,
      watch: false
    })
    if (err.value || !data.value) {
      const detail = err.value?.data as { statusMessage?: string } | undefined
      throw new Error(detail?.statusMessage || err.value?.message || '上传失败')
    }
    progress.value = 90
    result.value = data.value as unknown as NovelResult

    // 拉取解析后的世界观速览(world_state)
    const { data: detail } = await useFetch<Record<string, unknown>>(`/api/novels/${data.value.id}`, { watch: false })
    const ws = detail.value?.world_state
    if (typeof ws === 'string' && ws) {
      try {
        world.value = JSON.parse(ws) as WorldOverlay
      } catch {
        world.value = null
      }
    }
    progress.value = 100
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="min-h-[92vh] flex items-center justify-center px-4 py-12">
    <div class="w-full max-w-2xl space-y-6">
      <div class="text-center space-y-2">
        <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">
          AI StoryBound
        </h1>
        <p class="text-lg text-neutral-500 dark:text-neutral-400">
          上传一本小说，选择一个身份，走进故事，亲手改变原本的结局。
        </p>
      </div>

      <UCard>
        <!-- 选择区 / 上传中 / 结果 -->
        <div
          v-if="!result"
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
            :loading="uploading"
            :disabled="!selected || uploading"
            @click="upload"
          >
            {{ uploading ? '解析中 …' : '上传并生成故事' }}
          </UButton>

          <UProgress
            v-if="uploading"
            :value="progress"
            class="w-full max-w-xs"
          />
          <UAlert
            v-if="error"
            color="error"
            variant="soft"
            :title="error"
            :icon="'i-lucide-triangle-alert'"
          />
        </div>

        <!-- 结果展示 -->
        <div
          v-else
          class="space-y-4"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-xl font-semibold">
                {{ world?.title || result.title }}
              </h2>
              <p class="text-sm text-neutral-500">
                {{ world?.genre || '未知题材' }} · {{ result.chapter_count }} 章 · {{ result.encoding.toUpperCase() }} 编码
              </p>
            </div>
            <UBadge
              color="success"
              variant="soft"
              label="解析完成"
            />
          </div>

          <p
            v-if="world?.summary"
            class="text-sm text-neutral-600 dark:text-neutral-300"
          >
            {{ world.summary }}
          </p>

          <div v-if="world?.characters?.length">
            <p class="mb-2 text-sm font-medium">
              登场角色
            </p>
            <ul class="space-y-1.5">
              <li
                v-for="c in world.characters"
                :key="c.name"
                class="flex items-baseline gap-2 text-sm"
              >
                <UBadge
                  :color="c.role === '主角' ? 'primary' : c.role === '反派' ? 'error' : 'neutral'"
                  variant="subtle"
                  :label="c.role"
                />
                <span class="font-medium">{{ c.name }}</span>
                <span class="text-neutral-500">{{ c.description }}</span>
              </li>
            </ul>
          </div>

          <div class="flex gap-2 pt-1">
            <UButton
              label="进入故事（开发中）"
              color="primary"
              icon="i-lucide-play"
              disabled
            />
            <UButton
              label="上传另一本"
              color="neutral"
              variant="outline"
              @click="result = null; world = null; selected = null"
            />
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
