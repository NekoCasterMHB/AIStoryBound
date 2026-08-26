<script setup lang="ts">
// 三步玩法:编号卡片 + 图标,保留原首页三段核心文案。
const steps = [
  {
    icon: 'i-lucide-upload',
    title: '上传 TXT',
    desc: '整本小说本地解析切章,正文只留在你的浏览器,不上传云端。'
  },
  {
    icon: 'i-lucide-brain-circuit',
    title: 'AI 生成世界观',
    desc: '分章提取人物/地点/势力/规则/伏笔 → 自动合并去重 → 引用校验 → 一致性检查 → 完整人物卡。'
  },
  {
    icon: 'i-lucide-gamepad-2',
    title: '扮演角色,改变结局',
    desc: '选择身份进入故事,自由行动或选 AI 建议,回合式推进,随时回滚重选。'
  }
]
</script>

<template>
  <section
    id="how"
    class="relative"
  >
    <div class="mx-auto max-w-6xl px-4 pb-20 pt-4">
      <div class="mb-10 text-center">
        <p class="text-xs font-semibold tracking-widest text-primary-600 dark:text-primary-400">
          玩法
        </p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
          三步,进入故事
        </h2>
        <p class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          从一本你熟悉的小说,到一场由你改写命运的冒险。
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-3">
        <div
          v-for="(s, i) in steps"
          :key="s.title"
          v-reveal
          class="group relative overflow-hidden rounded-2xl border border-neutral-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-primary-500/40 hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-500)_30%,transparent)] dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30 dark:hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-400)_15%,transparent)]"
        >
          <span
            class="absolute right-5 top-3 text-4xl font-bold text-neutral-100 transition-colors duration-300 group-hover:text-primary-500/20 dark:text-neutral-800 dark:group-hover:text-primary-400/15"
            aria-hidden="true"
          >
            {{ `0${i + 1}` }}
          </span>
          <div class="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary-500/15 text-primary-600 dark:text-primary-400">
            <UIcon
              :name="s.icon"
              class="size-5"
            />
          </div>
          <h3 class="font-semibold text-highlighted">
            {{ s.title }}
          </h3>
          <p class="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {{ s.desc }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>