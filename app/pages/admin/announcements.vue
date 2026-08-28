<script setup lang="ts">
import { MAX_ANNOUNCEMENT_CONTENT_CHARS, MAX_ANNOUNCEMENT_TITLE_CHARS, type AnnouncementItem } from '#shared/announcement'

// /admin/announcements — 公告管理(管理后台):发布/编辑/删除站内公告。
// 公告存 D1(announcements 表),客户端全站弹窗展示;支持草稿(不勾选发布)与 markdown 内容。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 公告管理' })

const toast = useToast()

const rows = ref<AnnouncementItem[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    rows.value = await $fetch<AnnouncementItem[]>('/api/admin/announcements')
  } catch (e) {
    toast.add({ title: '加载公告失败', description: errText(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
})

function errText(e: unknown): string {
  if (e instanceof Error) {
    const data = (e as { data?: { statusMessage?: string } }).data
    return data?.statusMessage || e.message
  }
  return String(e)
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---- 新建 / 编辑 ----
const modalOpen = ref(false)
const modal = reactive({
  id: null as string | null,
  title: '',
  content: '',
  published: true
})
const modalBusy = ref(false)
const modalError = ref<string | null>(null)

function openCreate() {
  modal.id = null
  modal.title = ''
  modal.content = ''
  modal.published = true
  modalError.value = null
  modalOpen.value = true
}

function openEdit(a: AnnouncementItem) {
  modal.id = a.id
  modal.title = a.title
  modal.content = a.content
  modal.published = a.published
  modalError.value = null
  modalOpen.value = true
}

async function onSave() {
  modalBusy.value = true
  modalError.value = null
  try {
    const body = { title: modal.title, content: modal.content, published: modal.published }
    if (modal.id) {
      await $fetch(`/api/admin/announcements/${modal.id}`, { method: 'PUT', body })
    } else {
      await $fetch('/api/admin/announcements', { method: 'POST', body })
    }
    toast.add({
      title: modal.id ? '公告已更新' : '公告已创建',
      description: modal.published ? '客户端将在下次访问时弹出' : '未发布,保存为草稿',
      color: 'success'
    })
    modalOpen.value = false
    void load()
  } catch (e) {
    modalError.value = errText(e)
  } finally {
    modalBusy.value = false
  }
}

// ---- 删除确认 ----
const deleteOpen = ref(false)
const deleteTarget = ref<AnnouncementItem | null>(null)
const deleteBusy = ref(false)

function askDelete(a: AnnouncementItem) {
  deleteTarget.value = a
  deleteOpen.value = true
}

async function onDelete() {
  if (!deleteTarget.value || deleteBusy.value) return
  deleteBusy.value = true
  try {
    const t = deleteTarget.value
    await $fetch(`/api/admin/announcements/${t.id}`, { method: 'DELETE' })
    toast.add({ title: `已删除公告「${t.title}」`, color: 'success' })
    deleteOpen.value = false
    void load()
  } catch (e) {
    toast.add({ title: '删除失败', description: errText(e), color: 'error' })
  } finally {
    deleteBusy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          公告管理
        </h1>
        <p class="text-sm text-neutral-500">
          发布站内公告,客户端全站弹窗展示;内容支持 markdown,可保存为草稿稍后发布
        </p>
      </div>
      <UButton
        icon="i-lucide-plus"
        color="primary"
        @click="openCreate"
      >
        新建公告
      </UButton>
    </div>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                标题
              </th>
              <th class="py-2 pr-3 font-medium">
                状态
              </th>
              <th class="py-2 pr-3 font-medium">
                创建时间
              </th>
              <th class="py-2 pr-3 font-medium">
                更新时间
              </th>
              <th class="py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td
                colspan="5"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="5"
                class="py-6 text-center text-neutral-500"
              >
                暂无公告,点击右上角「新建公告」发布第一条
              </td>
            </tr>
            <tr
              v-for="a in rows"
              :key="a.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="max-w-80 truncate py-2.5 pr-3">
                <span class="font-medium">{{ a.title }}</span>
              </td>
              <td class="py-2.5 pr-3">
                <UBadge
                  size="sm"
                  :color="a.published ? 'success' : 'neutral'"
                  variant="soft"
                >
                  {{ a.published ? '已发布' : '草稿' }}
                </UBadge>
              </td>
              <td class="py-2.5 pr-3 text-xs text-neutral-500">
                {{ fmtDateTime(a.createdAt) }}
              </td>
              <td class="py-2.5 pr-3 text-xs text-neutral-500">
                {{ fmtDateTime(a.updatedAt) }}
              </td>
              <td class="py-2.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="soft"
                    icon="i-lucide-pencil"
                    @click="openEdit(a)"
                  >
                    编辑
                  </UButton>
                  <UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash"
                    @click="askDelete(a)"
                  >
                    删除
                  </UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- 新建 / 编辑弹窗 -->
    <UModal
      v-model:open="modalOpen"
      :title="modal.id ? '编辑公告' : '新建公告'"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            label="标题"
            required
          >
            <UInput
              v-model="modal.title"
              placeholder="公告标题"
              :maxlength="MAX_ANNOUNCEMENT_TITLE_CHARS"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="内容"
            required
            :hint="`支持 markdown(如 **加粗**、[链接](url))`"
          >
            <UTextarea
              v-model="modal.content"
              placeholder="公告内容…"
              :maxlength="MAX_ANNOUNCEMENT_CONTENT_CHARS"
              :rows="8"
              class="w-full"
            />
          </UFormField>

          <USwitch
            v-model="modal.published"
            label="立即发布"
          />
          <p class="text-xs text-neutral-500">
            不勾选则保存为草稿,客户端不会展示;编辑时勾选即发布
          </p>

          <p
            v-if="modalError"
            class="text-xs text-red-500"
          >
            {{ modalError }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="modalOpen = false"
          >
            取消
          </UButton>
          <UButton
            icon="i-lucide-check"
            :loading="modalBusy"
            @click="onSave"
          >
            保存
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 删除确认 -->
    <UModal
      v-model:open="deleteOpen"
      title="删除公告"
    >
      <template #body>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
          确定删除公告「{{ deleteTarget?.title }}」吗?删除后不可恢复,已选择「不再提示」的用户不受影响。
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="deleteOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-trash"
            :loading="deleteBusy"
            @click="onDelete"
          >
            删除
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
