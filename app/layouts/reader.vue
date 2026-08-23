<script setup>
// 沉浸式阅读布局:无导航栏/页脚/登录模态框的裸全屏容器,由阅读页自身占满视口。
// 页面进入时通过 definePageMeta({ layout: 'reader' }) 选用本布局。
</script>

<template>
  <div class="h-dvh w-full overflow-hidden">
    <slot />
  </div>
</template>
