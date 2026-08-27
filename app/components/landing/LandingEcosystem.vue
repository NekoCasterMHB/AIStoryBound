<script setup lang="ts">
// 「创意工坊与生态」:创意工坊三大板块(书架/Skill包/功能插件)+ 故事分享,四卡网格。
// 卡片文案基于产品真实行为:书架试读字数由发布者设定、购买入本地书架、发布分成 80%,
// Skill 下载即装、功能插件开发中、游戏页分享菜单与书架导入 ZIP。
const blocks = [
  {
    icon: 'i-lucide-book-open',
    title: '书架 · 小说商城',
    desc: '用 token 购买小说,加入书架后可阅读,也能用 AI 生成世界亲自扮演。\n试读字数由发布者设定,先看后买不吃亏。',
    points: [
      '付费前免费试读:发布者设定试读字数,正文开头先睹为快',
      '购买即入书架:可阅读、可生成世界扮演,新版本一键跟进',
      '发布小说赚 token:每售出一本实得售价的 80%'
    ],
    cta: { label: '去书架逛逛', icon: 'i-lucide-book-open', to: '/workshop?tab=novels' }
  },
  {
    icon: 'i-lucide-package',
    title: 'Skill包 · 玩法商城',
    desc: '用 token 选购 agent skill 玩法,下载即自动安装并启用。\n游玩时 AI 按技能的 SOP 指引展开,专业玩法与专属人格,随买随用。',
    points: [
      '专业玩法:技能内嵌作者沉淀的 SOP 指引,装上即拥有专业级玩法体验',
      '专属人格:人格 / 调教类技能,可调教出符合你 xp 的专属 AI 人格',
      '下载即装:校验后自动入技能库并启用,发布你的 Skill 还能赚钱'
    ],
    cta: { label: '逛 Skill包', icon: 'i-lucide-package', to: '/workshop?tab=skills' }
  },
  {
    icon: 'i-lucide-plug-zap',
    title: '功能插件 · 开发中',
    desc: '赋予 AI 操作外部设备的能力(小玩具联动等 你懂的对吧~),\n让游玩体验突破屏幕,敬请期待。',
    points: [
      '玩法联动:AI 驱动实体设备,沉浸感拉满',
      '自由组合:功能插件与 Skill 玩法叠加生效',
      '开发中:欢迎去需求墙提出你想要的联动功能'
    ],
    cta: { label: '去需求墙', icon: 'i-lucide-lightbulb', to: '/demand' }
  },
  {
    icon: 'i-lucide-share-2',
    title: '分享你的故事',
    desc: '游戏对话随时可分享:剧情 TXT,或包含完整作品与会话的 ZIP 分享包。\n对方在书架上导入分享包,校验通过后即还原为个人作品。',
    points: [
      '分享剧情 TXT:剔除玩家操作,只留纯旁白,方便阅读收藏',
      '分享全部 ZIP:作品 + 会话 + 剧情一次打包,随时备份与迁移',
      '书架导入 ZIP:格式校验后作为个人作品入库,立即开玩'
    ],
    cta: { label: '去书架逛逛', icon: 'i-lucide-library-big', to: '/works' }
  }
]
</script>

<template>
  <section class="border-t border-neutral-200/70 dark:border-neutral-800/70">
    <div class="mx-auto max-w-6xl px-4 py-20">
      <div class="mb-10 text-center">
        <p class="text-xs font-semibold tracking-widest text-primary-600 dark:text-primary-400">
          创意工坊
        </p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
          故事可以分享,玩法可以生长
        </h2>
        <p class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          社区创作集中地:在「书架」买卖小说、在「Skill包」买卖玩法技能,发布内容实得售价的 80%;「功能插件」正在开发,敬请期待。
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div
          v-for="b in blocks"
          :key="b.title"
          v-reveal
          class="group flex flex-col rounded-2xl border border-neutral-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-primary-500/40 hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-500)_30%,transparent)] dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-primary-500/30 dark:hover:shadow-[0_16px_40px_-16px_color-mix(in_srgb,var(--color-primary-400)_15%,transparent)]"
        >
          <div class="mb-3 flex size-10 items-center justify-center rounded-xl bg-linear-to-br from-primary-500/15 to-primary-400/15 text-primary-600 transition-transform duration-300 group-hover:scale-110 dark:text-primary-400">
            <UIcon
              :name="b.icon"
              class="size-5"
            />
          </div>
          <h3 class="font-semibold text-highlighted">
            {{ b.title }}
          </h3>
          <p class="mt-2 whitespace-pre-line text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {{ b.desc }}
          </p>
          <ul class="mt-4 flex-1 space-y-2">
            <li
              v-for="p in b.points"
              :key="p"
              class="flex items-start gap-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400"
            >
              <UIcon
                name="i-lucide-circle-check"
                class="mt-0.5 size-4 shrink-0 text-primary-600 dark:text-primary-400"
              />
              <span>{{ p }}</span>
            </li>
          </ul>
          <UButton
            class="mt-6 self-start"
            color="primary"
            variant="soft"
            :icon="b.cta.icon"
            :to="b.cta.to"
          >
            {{ b.cta.label }}
          </UButton>
        </div>
      </div>
    </div>
  </section>
</template>
