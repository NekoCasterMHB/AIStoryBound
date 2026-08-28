<script setup lang="ts">
// PluginGuideModal.vue — 配置制作指导文档弹窗:模态框内渲染 PLUGIN_GUIDE.md(markdown),
// 支持下载指南 (.md)、示例清单 (.json) 与完整模板 (zip)。
// 指南源文件:app/toy/sdk-template/(PLUGIN_GUIDE.md / manifest.example.json / adapter.example.js)
import { parseMarkdown } from '@nuxtjs/mdc/runtime'
import { strToU8, zipSync } from 'fflate'
import guideMd from '../toy/sdk-template/PLUGIN_GUIDE.md?raw'
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
    const res = await parseMarkdown(guideMd)
    body.value = res.body
  } catch {
    // 渲染失败时回退纯文本展示(下方 v-else pre)
  } finally {
    mdLoading.value = false
  }
}, { immediate: true })

function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 下载指南 markdown */
function downloadGuide() {
  downloadBlob(guideMd, 'PLUGIN_GUIDE.md', 'text/markdown;charset=utf-8')
}

/** 下载示例清单 */
function downloadManifest() {
  downloadBlob(manifestJson, 'manifest.example.json', 'application/json;charset=utf-8')
}

/** 打包完整模板为 zip 下载 */
function downloadZip() {
  const zip = zipSync({
    'sdk-template/PLUGIN_GUIDE.md': strToU8(guideMd),
    'sdk-template/manifest.example.json': strToU8(manifestJson),
    'sdk-template/adapter.example.js': strToU8(adapterJs)
  })
  downloadBlob(zip, 'plugin-sdk-template.zip', 'application/zip')
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
        插件配置制作指南
      </span>
    </template>
    <template #body>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-download"
          @click="downloadGuide"
        >
          下载指南 (.md)
        </UButton>
        <UButton
          size="xs"
          variant="soft"
          icon="i-lucide-file-json"
          @click="downloadManifest"
        >
          示例清单 (.json)
        </UButton>
        <UButton
          size="xs"
          variant="soft"
          icon="i-lucide-file-archive"
          @click="downloadZip"
        >
          完整模板 (zip)
        </UButton>
        <span class="ml-auto text-xs text-neutral-400">
          强制格式:缺必填字段(含强度上限)导入会被拒绝
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
        >{{ guideMd }}</pre>
      </div>
    </template>
  </UModal>
</template>
