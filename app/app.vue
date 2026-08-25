<script setup>
// dev 下 manifest.webmanifest 仅 build 生成,不存在于 public;不渲染链接,避免浏览器请求 302/解析报错
const isDev = import.meta.dev

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    // 与 manifest.theme_color 保持一致:Android 地址栏/状态栏着色
    { name: 'theme-color', content: '#00DC82' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
    // @vite-pwa/nuxt 不会自动向 SSR HTML 注入 manifest 链接,需手动声明,否则无法安装为 PWA
    ...(!isDev ? [{ rel: 'manifest', href: '/manifest.webmanifest' }] : []),
    // iOS 主屏图标(iOS 不读取 manifest icons)
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }
  ],
  htmlAttrs: {
    lang: 'zh-CN'
  }
})

const title = 'AISpankWorld'
const description = 'AI 小说驱动互动游戏平台 —— 上传一本小说,选择一个身份,进入故事,并亲手改变原本的结局。'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
