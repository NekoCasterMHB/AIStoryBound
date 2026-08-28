<script setup lang="ts">
// AnnouncementModal.vue — 全局公告弹窗(挂在 app.vue,全站生效)。
// 加载时拉取已发布公告,与 localStorage 已读游标比对:存在未读(createdAt 大于游标)才弹出,
// 多条未读用 UAccordion 手风琴展示(默认展开最新一条,内容 markdown 由 MDC 渲染)。
// 勾选「有新公告前不再提示」关闭 → 游标更新到最新公告,此后仅当出现更新的公告才再次弹出;
// 不勾选直接关闭 → 本次页面会话不再自动弹,刷新后仍会提示。
import { parseMarkdown } from '@nuxtjs/mdc/runtime'
import type { AccordionItem } from '@nuxt/ui'
import type { AnnouncementItem } from '#shared/announcement'

type MarkdownBody = Awaited<ReturnType<typeof parseMarkdown>>['body']

const open = ref(false)
const dontShowAgain = ref(false)
/** 未读公告(服务端已按 createdAt 倒序,最新在前) */
const unread = ref<AnnouncementItem[]>([])
/** 每条公告的 markdown 渲染树(与 unread 一一对应;解析失败为 null 时回退纯文本) */
const mdBodies = ref<(MarkdownBody | null)[]>([])
/** 本次页面会话只检查一次,避免重复弹窗 */
let sessionChecked = false

const accordionItems = computed<AccordionItem[]>(() =>
  unread.value.map(a => ({
    label: `${fmtDate(a.createdAt)} · ${a.title}`,
    value: a.id,
    slot: 'announcement'
  }))
)

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function checkAndOpen() {
  if (sessionChecked) return
  sessionChecked = true
  try {
    const list = await $fetch<AnnouncementItem[]>('/api/announcements')
    const items = list.filter(a => a.createdAt > getAnnouncementReadUntil())
    if (!items.length) return
    // 预解析 markdown;解析失败保留 null,模板回退纯文本
    const bodies = await Promise.all(items.map(async (a) => {
      try {
        const res = await parseMarkdown(a.content)
        return res.body
      } catch {
        return null
      }
    }))
    mdBodies.value = bodies
    unread.value = items
    open.value = true
  } catch {
    // 拉取失败不打扰用户,静默跳过本次检查
  }
}

onMounted(() => {
  void checkAndOpen()
})

/**
 * 记录已读游标并重置弹窗状态:勾选了「不再提示」→ 游标更新到最新公告(此后仅新公告再次弹出)。
 * 注意:UModal(ReKa Dialog)受控模式下,「知道了」按钮直接改 open 是 prop 驱动关闭,
 * 不会触发 update:open 事件,因此持久化必须由按钮显式调用,不能只挂在 onClose 上。
 */
function persistReadState() {
  const latest = unread.value[0]
  if (dontShowAgain.value && latest) {
    setAnnouncementReadUntil(latest.createdAt)
  }
  dontShowAgain.value = false
  unread.value = []
  mdBodies.value = []
}

/** 内部关闭路径(Close 按钮 / 遮罩点击 / ESC)会 emit update:open */
function onClose(nextOpen: boolean) {
  if (!nextOpen) persistReadState()
}

/** 「知道了」按钮:手动持久化后驱动关闭 */
function onConfirm() {
  persistReadState()
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :ui="{ content: 'sm:max-w-lg' }"
    @update:open="onClose"
  >
    <template #title>
      <span class="flex items-center gap-2">
        <UIcon
          name="i-lucide-megaphone"
          class="size-5 text-primary"
        />
        公告
      </span>
    </template>

    <template #body>
      <UAccordion
        v-if="unread.length"
        :items="accordionItems"
        :default-value="unread[0]?.id"
        class="w-full"
      >
        <template #announcement="{ index }">
          <article
            v-if="mdBodies[index]"
            class="prose prose-sm max-w-none dark:prose-invert"
          >
            <MDCRenderer :body="mdBodies[index]" />
          </article>
          <pre
            v-else
            class="whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-600 dark:text-neutral-300"
          >{{ unread[index]?.content }}</pre>
        </template>
      </UAccordion>
    </template>

    <template #footer>
      <div class="flex items-center justify-between gap-3">
        <UCheckbox
          v-model="dontShowAgain"
          label="有新公告前不再提示"
        />
        <UButton
          icon="i-lucide-check"
          color="primary"
          size="lg"
          class="px-8"
          @click="onConfirm"
        >
          知道了
        </UButton>
      </div>
    </template>
  </UModal>
</template>
