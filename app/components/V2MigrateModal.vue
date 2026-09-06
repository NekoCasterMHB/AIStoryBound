<!-- app/components/V2MigrateModal.vue -->
<!-- 书架 v2 转换提示模态框:检测到旧格式(v1 works)作品时由书架自动弹出。
     流程:dry-run 明细 → 「备份并转换」(迁移前下载 v1 备份 zip,成功才删旧,失败保留)→ 回显结果;
     「稍后」不做任何修改,旧作品仍以过渡视图展示,下次进入书架再次提示。 -->
<script setup lang="ts">
import { migrateDryRun, migrateAllWorksToV2, buildMigrateBackup } from '~/utils/migrateV2'
import { listWorks } from '~/utils/worldGen'
import type { MigrateDryRun } from '~/utils/migrateV2'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean], 'migrated': [] }>()

const scanning = ref(false)
const converting = ref(false)
const dry = ref<MigrateDryRun | null>(null)
const done = ref<{ migrated: string[], failures: { title: string, error?: string }[] } | null>(null)
const toast = useToast()

watch(() => props.open, async (v) => {
  if (!v) return
  done.value = null
  scanning.value = true
  try {
    dry.value = await migrateDryRun()
  } finally {
    scanning.value = false
  }
})

function close() {
  emit('update:open', false)
}

/** 迁移前备份:候选旧 works 全量 JSON 打包 zip 下载(转换后旧数据即删,备份用于手动回退) */
async function downloadBackup() {
  const works = await listWorks()
  const ids = new Set((dry.value?.items ?? []).map(i => i.id))
  const backup = buildMigrateBackup(works.filter(w => ids.has(w.id)))
  const url = URL.createObjectURL(new Blob([backup.buffer as ArrayBuffer], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `v2迁移备份-${new Date().toISOString().slice(0, 10)}.zip`
  a.click()
  URL.revokeObjectURL(url)
}

async function convert() {
  if (converting.value) return
  converting.value = true
  try {
    await downloadBackup()
    const res = await migrateAllWorksToV2()
    done.value = {
      migrated: res.migrated.map(m => m.title),
      failures: res.failures.map(f => ({ title: f.title, error: f.error }))
    }
    toast.add({
      title: `转换完成:${res.migrated.length} 成功 / ${res.failures.length} 失败`,
      description: res.failures.length ? '失败作品已保留旧数据,可重试' : '备份 zip 已下载,确认无误后可自行删除',
      color: res.failures.length ? 'warning' : 'success'
    })
    if (res.migrated.length) emit('migrated')
  } finally {
    converting.value = false
  }
}
</script>

<template>
  <UModal
    :open="props.open"
    title="作品格式升级"
    description="检测到旧格式作品,建议转换为新版格式(v2);转换前会自动下载备份"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="space-y-3">
        <div
          v-if="scanning"
          class="flex items-center gap-2 text-sm text-muted"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          正在检测旧格式作品…
        </div>

        <template v-else-if="dry">
          <p class="text-sm">
            共 <b>{{ dry.total }}</b> 部作品可转换为新格式(v2),转换后阅读、游玩与云端同步走同一份数据。
          </p>
          <ul class="max-h-40 space-y-1 overflow-y-auto text-sm">
            <li
              v-for="item in dry.items"
              :key="item.id"
              class="flex items-center gap-2"
            >
              <UIcon
                name="i-lucide-book"
                class="size-4 shrink-0 text-muted"
              />
              <span class="truncate">{{ item.title }}</span>
            </li>
          </ul>
          <div
            v-if="dry.failures.length"
            class="rounded-md bg-elevated p-2 text-sm"
          >
            <p class="mb-1 font-medium text-warning">
              以下 {{ dry.failures.length }} 部无法自动转换(已跳过,不受影响):
            </p>
            <p
              v-for="f in dry.failures"
              :key="f.id"
              class="text-muted"
            >
              {{ f.title }}:{{ f.error }}
            </p>
          </div>

          <div
            v-if="done"
            class="rounded-md bg-elevated p-2 text-sm"
          >
            <p class="font-medium text-success">
              本轮已转换 {{ done.migrated.length }} 部
            </p>
            <p
              v-for="f in done.failures"
              :key="f.title"
              class="text-warning"
            >
              {{ f.title }}:{{ f.error }}(旧数据已保留)
            </p>
          </div>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          label="稍后"
          color="neutral"
          variant="outline"
          :disabled="converting"
          @click="close"
        />
        <UButton
          label="备份并转换"
          icon="i-lucide-arrow-right-left"
          color="primary"
          :loading="converting"
          :disabled="scanning || !dry || dry.items.length === 0"
          @click="convert"
        />
      </div>
    </template>
  </UModal>
</template>
