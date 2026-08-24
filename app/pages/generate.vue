<script setup lang="ts">
// /generate — 生成世界页(游客可见,但生成需要登录):未登录显示引导卡 + 弹出登录模态框;
// 登录后选择 TXT → 本地编排生成(实时 token 消耗)→ 完成 → 跳选角页。
import { parseLocalNovel, generateWorld } from '../utils/worldGen'
import { useAuthModal } from '~/composables/useAuthModal'
import { useAuthSession } from '../utils/auth-client'
import type { LocalWork } from '#shared/novel'
import type { GenerateProgress } from '../utils/worldGen'

useHead({ title: 'AI StoryBound · 生成世界' })

const { data: session } = await useAuthSession()
const loggedIn = computed(() => !!session.value?.user)
const { requireLogin } = useAuthModal()

const resultWork = ref<LocalWork | null>(null)

const fileInput = ref<HTMLInputElement | null>(null)
const picking = ref(false)
const genState = ref<{
  phase: 'idle' | 'parsing' | 'generating' | 'done' | 'error'
  title: string
  progress: GenerateProgress | null
  error: string | null
  resultId: string | null
  tokensUsed: number
}>({
  phase: 'idle',
  title: '',
  progress: null,
  error: null,
  resultId: null,
  tokensUsed: 0
})

const stageLabel: Record<string, string> = {
  parse: '解析文件…',
  author: '识别作者…',
  extract: '提取世界观元素…',
  merge: '合并实体与校验引用…',
  check: '一致性检查…',
  synthesize: '生成人物卡与简介…',
  done: '完成'
}

const genPercent = computed(() => {
  const p = genState.value.progress
  if (!p) return 30
  if (p.stage === 'extract') {
    return p.totalUnits ? Math.round(p.doneUnits / p.totalUnits * 100) : 0
  }
  const stageBase: Record<string, number> = { author: 20, merge: 85, check: 92, synthesize: 96, done: 100 }
  return stageBase[p.stage] ?? 30
})

// 未登录访问:引导登录(不强制跳页)
const askingLogin = ref(false)
onMounted(async () => {
  if (!loggedIn.value && !askingLogin.value) {
    askingLogin.value = true
    await requireLogin()
    askingLogin.value = false
  }
})

function onPickFile() {
  picking.value = true
  fileInput.value?.click()
}

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  picking.value = false
  genState.value = { phase: 'parsing', title: file.name, progress: null, error: null, resultId: null, tokensUsed: 0 }
  try {
    const parsed = await parseLocalNovel(file)
    genState.value.title = parsed.title
    await runGeneration(parsed.title, parsed.chapters, parsed.frontMatter)
  } catch (err) {
    genState.value = {
      phase: 'error',
      title: file.name,
      progress: null,
      error: err instanceof Error ? err.message : String(err),
      resultId: null,
      tokensUsed: 0
    }
  }
}

async function runGeneration(title: string, chapters: Parameters<typeof generateWorld>[1], frontMatter: string) {
  genState.value.phase = 'generating'
  const { work } = await generateWorld(title, chapters, (p) => {
    genState.value.progress = { ...p }
  }, { frontMatter })
  genState.value.phase = 'done'
  genState.value.progress = null
  genState.value.resultId = work.id
  genState.value.tokensUsed = work.tokensUsed ?? 0
  resultWork.value = work
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-8">
    <div class="mb-6 flex items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          生成世界
        </h1>
        <p class="text-sm text-neutral-500">
          上传整本 TXT,AI 分章提取并自动合并校验,生成可玩的世界观
        </p>
      </div>
      <UButton
        label="返回首页"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="outline"
        size="sm"
        to="/"
      />
    </div>

    <!-- 未登录引导 -->
    <UCard
      v-if="!loggedIn"
      class="py-10 text-center"
    >
      <UIcon
        name="i-lucide-lock"
        class="mx-auto size-8 text-neutral-400"
      />
      <p class="mt-3 font-semibold">
        生成世界需要登录
      </p>
      <p class="text-sm text-neutral-500">
        登录后即可上传小说并使用平台配额/自带 API Key 生成
      </p>
      <UButton
        class="mt-4"
        color="primary"
        icon="i-lucide-log-in"
        @click="requireLogin"
      >
        登录 / 注册
      </UButton>
    </UCard>

    <!-- 上传生成 -->
    <UCard
      v-else
      class="mb-6"
    >
      <input
        ref="fileInput"
        type="file"
        accept=".txt,.text"
        class="hidden"
        @change="onFileChosen"
      >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="font-semibold">
            导入小说,开始生成
          </p>
          <p class="text-sm text-neutral-500">
            正文只在本地解析与保存,不离开你的设备
          </p>
        </div>
        <UButton
          color="primary"
          icon="i-lucide-upload"
          :loading="picking || genState.phase === 'generating'"
          @click="onPickFile"
        >
          选择 TXT 文件
        </UButton>
      </div>

      <div
        v-if="genState.phase === 'parsing' || genState.phase === 'generating'"
        class="mt-4 space-y-3"
      >
        <p class="text-sm font-medium">
          {{ genState.title }}
        </p>
        <UProgress
          v-if="genState.progress"
          :value="genPercent"
          size="sm"
        />
        <p class="text-xs text-neutral-500">
          {{ stageLabel[genState.progress?.stage ?? 'parse'] }}
          <template v-if="genState.progress?.stage === 'extract'">
            {{ genState.progress.doneUnits }}/{{ genState.progress.totalUnits }} 单元
          </template>
          <span
            v-if="genState.progress && (genState.progress.tokensUsed || genState.progress.liveTokens)"
            class="ml-2 tabular-nums"
          >
            · 已消耗 {{ (genState.progress.liveTokens ?? genState.progress.tokensUsed).toLocaleString() }} tokens
            <template v-if="genState.progress.liveSpeed"> · {{ genState.progress.liveSpeed }}/s</template>
          </span>
        </p>
        <ul
          v-if="genState.progress?.warnings?.length"
          class="space-y-0.5"
        >
          <li
            v-for="(w, i) in genState.progress.warnings.slice(0, 3)"
            :key="i"
            class="text-xs text-amber-500"
          >
            ⚠ {{ w }}
          </li>
        </ul>
      </div>

      <UAlert
        v-if="genState.phase === 'error'"
        class="mt-4"
        color="error"
        variant="soft"
        :title="genState.error || '生成失败'"
      />
      <div
        v-if="genState.phase === 'done'"
        class="mt-4 flex items-center justify-between gap-3"
      >
        <p class="text-sm text-emerald-600 dark:text-emerald-400">
          ✔ 世界生成完成<template v-if="resultWork?.author">
            ,作者:{{ resultWork.author }}
          </template><template v-if="genState.tokensUsed">
            ,共消耗 {{ genState.tokensUsed.toLocaleString() }} tokens
          </template>
        </p>
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-arrow-right"
          :to="`/play/${genState.resultId}`"
        >
          选择角色进入故事
        </UButton>
      </div>
    </UCard>

    <!-- 提示 -->
    <div
      v-if="loggedIn"
      class="grid gap-3 text-xs text-neutral-500 sm:grid-cols-3"
    >
      <div class="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <p class="font-semibold text-neutral-700 dark:text-neutral-300">
          📊 实时消耗
        </p>
        <p class="mt-1">
          生成全程显示 token 实时消耗与速度,完成后写入作品卡。
        </p>
      </div>
      <div class="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <p class="font-semibold text-neutral-700 dark:text-neutral-300">
          🔍 引用校验
        </p>
        <p class="mt-1">
          每条设定带原文引用并与正文比对,未通过校验的会标记告警。
        </p>
      </div>
      <div class="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <p class="font-semibold text-neutral-700 dark:text-neutral-300">
          ☁️ 云端同步
        </p>
        <p class="mt-1">
          生成结果可手动同步到云端,换设备恢复继续游玩。
        </p>
      </div>
    </div>
  </div>
</template>
