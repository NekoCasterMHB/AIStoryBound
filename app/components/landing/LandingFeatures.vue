<script setup lang="ts">
// 「为什么不一样」:产品真实差异点,图标卡片网格。
const features = [
  {
    icon: 'i-lucide-shield-check',
    title: '世界观一致',
    desc: '实体带原文引用与章节溯源,设定冲突自动列出并裁决,人物不会 OOC。'
  },
  {
    icon: 'i-lucide-rotate-ccw',
    title: '随时回滚重选',
    desc: '每一回合都可以回滚,回到任意历史分支,重新做出你的选择。'
  },
  {
    icon: 'i-lucide-activity',
    title: '消耗实时透明',
    desc: '生成与每一回合的 token 消耗实时显示,支持平台配额或自带 API Key。'
  },
  {
    icon: 'i-lucide-database',
    title: '本地优先',
    desc: '章节、实体库、人物卡都存在本地;登录后可手动同步云端,跨设备继续游玩。'
  },
  {
    icon: 'i-lucide-users',
    title: '完整人物卡',
    desc: '性格、目标、恐惧、秘密、关系网一应俱全,全部从原文提炼,拒绝 AI 脑补。'
  },
  {
    icon: 'i-lucide-file-text',
    title: '自动切章解析',
    desc: 'TXT 整本上传,自动识别章节结构并逐章分析,长篇也能轻松驾驭。'
  }
]
</script>

<template>
  <section class="relative border-t border-neutral-200/70 dark:border-neutral-800/70">
    <div class="mx-auto max-w-6xl px-4 py-20">
      <div class="mb-10 text-center">
        <p class="text-xs font-semibold tracking-widest text-primary-600 dark:text-primary-400">
          为什么选我们
        </p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight text-(--ui-text-highlighted) sm:text-3xl">
          不是聊天机器人,是忠于原著的世界
        </h2>
        <p class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          每个设定都追得到原文出处,每个角色都有据可依。
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="f in features"
          :key="f.title"
          v-reveal
          class="group rounded-2xl border border-neutral-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-primary-500/40 hover:shadow-[0_16px_40px_-16px_rgb(0_193_106/0.3)] dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30 dark:hover:shadow-[0_16px_40px_-16px_rgb(0_220_130/0.15)]"
        >
          <div class="mb-3 flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-green-500/15 to-teal-500/15 text-primary-600 transition-transform duration-300 group-hover:scale-110 dark:text-primary-400">
            <UIcon
              :name="f.icon"
              class="size-5"
            />
          </div>
          <h3 class="font-semibold text-(--ui-text-highlighted)">
            {{ f.title }}
          </h3>
          <p class="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {{ f.desc }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>