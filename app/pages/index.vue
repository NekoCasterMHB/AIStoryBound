<script setup lang="ts">
// 首页(游客可见):产品营销落地页。各内容区块见 components/landing/,导航栏与页脚由 layouts/default.vue 提供。
useHead({ title: 'AI Word2World — 把小说变成可走进的世界' })
</script>

<template>
  <div>
    <LandingHero />
    <LandingHow />
    <LandingFeatured />
    <LandingDemandWall />
    <LandingFeatures />
    <LandingEcosystem />
    <LandingFaq />
    <LandingCta />
  </div>
</template>
