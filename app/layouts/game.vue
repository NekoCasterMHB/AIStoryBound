<script setup>
// 游戏沉浸布局:无导航栏/页脚/登录模态框,占满视口且禁止整页滚动。
// 页面进入时通过 definePageMeta({ layout: 'game' }) 选用本布局;
// 游戏页自身管理内部滚动(剧情流区 flex-1 overflow-y-auto)。
</script>

<template>
  <div class="h-dvh w-full overflow-hidden">
    <slot />
  </div>
</template>
