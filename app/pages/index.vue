<script setup lang="ts">
// 首页(游客可见):产品营销落地页。各内容区块见 components/landing/,导航栏与页脚由 layouts/default.vue 提供。
useHead({ title: 'AI StoryBound — 把小说变成可走进的世界' })
</script>

<template>
  <div>
    <LandingHero />
    <LandingHow />
    <LandingFeatured />
    <LandingFeatures />
    <LandingFaq />
    <LandingCta />
  </div>
</template>