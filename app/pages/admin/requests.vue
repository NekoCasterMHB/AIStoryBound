<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { DEMAND_STATUS_LABELS } from '#shared/demand'
import type { DemandItem, DemandStatus } from '#shared/demand'

// /admin/requests — 需求墙管理(管理后台):标记实现状态(待实现/开发中/已实现)、删除需求。
definePageMeta({ layout: 'admin', middleware: 'admin' })

useHead({ title: 'AI Word2World · 需求管理' })

const toast = useToast()

const STATUS_COLORS: Record<DemandStatus, string> = {
  open: 'text-neutral-500',
  in_progress: 'text-primary',
  done: 'text-emerald-500'
}

const rows = ref<DemandItem[]>([])
const loading = ref(true)

async function loadRequests() {
  loading.value = true
  try {
    rows.value = await $fetch<DemandItem[]>('/api/admin/requests')
  } catch (e) {
    toast.add({ title: '加载需求列表失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void loadRequests()
})

function fmtTs(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

// ---- 状态切换 ----

function statusItems(r: DemandItem): DropdownMenuItem[] {
  return (Object.keys(DEMAND_STATUS_LABELS) as DemandStatus[]).map(s => ({
    label: DEMAND_STATUS_LABELS[s],
    icon: s === 'done' ? 'i-lucide-check' : (s === 'in_progress' ? 'i-lucide-hammer' : 'i-lucide-circle-dashed'),
    onSelect: () => void setStatus(r, s)
  }))
}

async function setStatus(r: DemandItem, status: DemandStatus) {
  if (r.status === status) return
  try {
    await $fetch(`/api/admin/requests/${r.id}/status`, { method: 'POST', body: { status } })
    r.status = status
    toast.add({ title: `已标记为「${DEMAND_STATUS_LABELS[status]}」`, color: 'success' })
  } catch (e) {
    toast.add({ title: '更新状态失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

// ---- 删除 ----
const deleteTarget = ref<DemandItem | null>(null)
const deleteOpen = ref(false)
const deleting = ref(false)

function onDelete(r: DemandItem) {
  deleteTarget.value = r
  deleteOpen.value = true
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/admin/requests/${target.id}/delete`, { method: 'POST' })
    rows.value = rows.value.filter(r => r.id !== target.id)
    deleteOpen.value = false
    toast.add({ title: '需求已删除', color: 'success' })
  } catch (e) {
    toast.add({ title: '删除失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <div class="mb-6">
      <h1 class="text-xl font-semibold">
        需求管理
      </h1>
      <p class="mt-1 text-sm text-neutral-500">
        标记需求实现进度(高赞优先实现),可删除违规需求
      </p>
    </div>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
              <th class="py-2 pr-3 font-medium">
                需求
              </th>
              <th class="py-2 pr-3 font-medium">
                发起人
              </th>
              <th class="py-2 pr-3 font-medium">
                点赞
              </th>
              <th class="py-2 pr-3 font-medium">
                状态
              </th>
              <th class="py-2 pr-3 font-medium">
                发起时间
              </th>
              <th class="py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td
                colspan="6"
                class="py-6 text-center text-neutral-500"
              >
                加载中…
              </td>
            </tr>
            <tr v-else-if="!rows.length">
              <td
                colspan="6"
                class="py-6 text-center text-neutral-500"
              >
                暂无需求
              </td>
            </tr>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td class="max-w-80 py-2.5 pr-3">
                <p class="truncate font-medium">
                  {{ r.title }}
                </p>
                <p class="line-clamp-2 text-xs text-neutral-500">
                  {{ r.desc }}
                </p>
              </td>
              <td class="max-w-36 truncate py-2.5 pr-3">
                <p class="truncate">
                  {{ r.authorName }}
                </p>
                <p
                  v-if="r.authorEmail"
                  class="truncate text-xs text-neutral-400"
                  :title="r.authorEmail"
                >
                  {{ r.authorEmail }}
                </p>
              </td>
              <td class="py-2.5 pr-3 tabular-nums">
                {{ r.likeCount }}
              </td>
              <td class="py-2.5 pr-3">
                <p :class="STATUS_COLORS[r.status]">
                  {{ DEMAND_STATUS_LABELS[r.status] }}
                </p>
              </td>
              <td class="py-2.5 pr-3">
                {{ fmtTs(r.createdAt) }}
              </td>
              <td class="py-2.5">
                <div class="flex gap-1">
                  <UDropdownMenu
                    :items="statusItems(r)"
                  >
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="soft"
                      icon="i-lucide-flag"
                    >
                      标记状态
                    </UButton>
                  </UDropdownMenu>
                  <UButton
                    size="xs"
                    color="error"
                    variant="outline"
                    icon="i-lucide-trash-2"
                    @click="onDelete(r)"
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

    <UModal
      v-model:open="deleteOpen"
      :title="`删除「${deleteTarget?.title ?? ''}」?`"
      description="删除后该需求与其点赞记录将一并清除,不可恢复"
    >
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="deleteOpen = false"
          >
            取消
          </UButton>
          <UButton
            color="error"
            :loading="deleting"
            @click="confirmDelete"
          >
            确认删除
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
