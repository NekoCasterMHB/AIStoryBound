<script setup lang="ts">
// SdkDocsModal.vue — 适配器 SDK 接入文档弹窗:模态框内预览 README(markdown 渲染),
// 支持打包下载完整 SDK 模板(zip)与逐个文件下载。
// 模板源文件:app/toy/sdk-template/(README.md / manifest.example.json / adapter.example.js)
import { parseMarkdown } from '@nuxtjs/mdc/runtime'
import { strToU8, zipSync } from 'fflate'
import readmeMd from '../toy/sdk-template/README.md?raw'
import manifestJson from '../toy/sdk-template/manifest.example.json?raw'
import adapterJs from '../toy/sdk-template/adapter.example.js?raw'

type MarkdownBody = Awaited<ReturnType<typeof parseMarkdown>>['body']

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const body = ref<MarkdownBody | null>(null)
const mdLoading = ref(false)

watch(() => props.open, async (open) => {
  if (!open || body.value) return
  mdLoading.value = true
  try {
    const res = await parseMarkdown(readmeMd)
    body.value = res.body
  } catch {
    // 渲染失败时回退纯文本展示(下方 v-else pre)
  } finally {
    mdLoading.value = false
  }
}, { immediate: true })

/** 模板文件清单(名称 → 内容;zip 下载与单文件下载共用) */
const SDK_FILES = [
  { name: 'README.md', content: readmeMd, desc: '接入文档' },
  { name: 'manifest.example.json', content: manifestJson, desc: '声明配置模板(Tier 1)' },
  { name: 'adapter.example.js', content: adapterJs, desc: '代码适配器示例(Tier 2)' }
] as const

function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 打包全部模板为 zip 下载 */
function downloadZip() {
  const zip = zipSync({
    'sdk-template/README.md': strToU8(readmeMd),
    'sdk-template/manifest.example.json': strToU8(manifestJson),
    'sdk-template/adapter.example.js': strToU8(adapterJs)
  })
  downloadBlob(zip, 'sdk-template.zip', 'application/zip')
}

function downloadFile(name: string, content: string) {
  downloadBlob(content, name, 'text/plain;charset=utf-8')
}
</script>

<template>
  <UModal
    :open="props.open"
    :ui="{ content: 'sm:max-w-3xl!' }"
    @update:open="emit('update:open', $event)"
  >
    <template #title>
      <span class="flex items-center gap-2">
        <UIcon
          name="i-lucide-book-open"
          class="size-5 text-primary"
        />
        适配器 SDK 接入文档
      </span>
    </template>
    <template #body>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-download"
          @click="downloadZip"
        >
          下载完整模板 (zip)
        </UButton>
        <UButton
          v-for="f in SDK_FILES"
          :key="f.name"
          size="xs"
          variant="soft"
          :title="f.desc"
          @click="downloadFile(f.name, f.content)"
        >
          {{ f.name }}
        </UButton>
        <span class="ml-auto text-xs text-neutral-400">
          模板即接入规范:改配置或写纯函数,打包导入即可
        </span>
      </div>
      <div class="max-h-[65vh] overflow-y-auto rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div
          v-if="mdLoading"
          class="py-10 text-center text-sm text-neutral-500"
        >
          文档加载中…
        </div>
        <article
          v-else-if="body"
          class="prose prose-sm max-w-none dark:prose-invert"
        >
          <MDCRenderer :body="body" />
        </article>
        <pre
          v-else
          class="whitespace-pre-wrap font-mono text-xs leading-relaxed"
        >{{ readmeMd }}</pre>
      </div>
    </template>
  </UModal>
</template>
