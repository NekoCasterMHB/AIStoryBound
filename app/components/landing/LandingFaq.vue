<script setup lang="ts">
import type { AccordionItem } from '@nuxt/ui'

// FAQ:全部基于产品真实行为撰写。
const items = ref<AccordionItem[]>([
  {
    label: '上传的小说出传云端吗?',
    content: '不会。解析与切章全部在本机完成,章节正文只保存在你的浏览器本地,不离开你的设备;只有当你在登录后主动选择同步时,作品数据才会上传到云端。'
  },
  {
    label: 'Token 是怎么消耗的?',
    content: '世界生成和每一回合的 AI 回复都会实时显示 token 用量与费用估算。你可以使用平台配额,也可以绑定自己的 API Key,消耗更透明、更可控。'
  },
  {
    label: '玩到一半选错了怎么办?',
    content: '每一回合的对话都可以回滚,回到任意历史分支重新选择,剧情线不会因此卡死或丢失。'
  },
  {
    label: '换设备还能继续玩吗?',
    content: '本地作品默认只保存在当前设备。登录账号后,可以把作品与游戏进度手动同步到云端,在另一台设备上恢复继续。'
  },
  {
    label: '支持哪些小说格式?',
    content: '目前支持 TXT 整本上传,上传后自动识别章节结构并逐章分析;未来会逐步补充 EPUB 等其他格式。'
  },
  {
    label: '怎么把玩过的故事分享给别人?',
    content: '游戏对话页顶部「分享」按钮有两个选项:「分享剧情 TXT」只保留旁白正文,方便直接阅读;「分享全部 ZIP」把完整作品、会话与剧情一次打包。对方在自己的书架选择「导入 ZIP 分享包」,校验通过后就作为个人作品入库,可以直接开玩。'
  },
  {
    label: 'Skill 商城是什么?怎么用?',
    content: 'Skill 商城用 token 选购 agent skill 玩法。下载后会自动校验、安装进技能库并启用,游戏时 AI 按技能的指引展开对应玩法;个人中心的「技能管理」可以随时逐项开关。你也可以发布自己的 Skill 定价出售,实得售价的 80%。'
  }
])
</script>

<template>
  <section
    id="faq"
    class="relative border-t border-neutral-200/70 dark:border-neutral-800/70"
  >
    <div class="mx-auto max-w-3xl px-4 py-20">
      <div class="mb-10 text-center">
        <p class="text-xs font-semibold tracking-widest text-primary-600 dark:text-primary-400">
          常见问题
        </p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight text-(--ui-text-highlighted) sm:text-3xl">
          还有疑问?
        </h2>
      </div>

      <UAccordion
        v-reveal
        :items="items"
        class="[&_[role=region]]:text-sm [&_[role=region]]:leading-relaxed [&_[role=region]]:text-neutral-600 dark:[&_[role=region]]:text-neutral-400"
      />
    </div>
  </section>
</template>
