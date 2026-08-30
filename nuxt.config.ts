// https://nuxt.com/docs/api/configuration/nuxt-config
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    // 管理端在线预览 SKILL.md:提供 MDCRenderer 组件与 parseMarkdown
    '@nuxtjs/mdc',
    // 仅本地 dev 生效:通过 getPlatformProxy 模拟 wrangler.toml 里的 Cloudflare binding
    // 部署时 nitro 的 cloudflare preset 提供真实 binding,两者访问方式一致(event.context.cloudflare.env)
    'nitro-cloudflare-dev',
    // PWA:可安装 + Workbox 预缓存离线壳。dev 下不注册 SW(devOptions.enabled: false),build 产物里生成 sw.js
    '@vite-pwa/nuxt'
  ],
  // 开发端口(生产部署与端口无关)

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  // LLM 网关默认值(构建期)。真实 Key 优先走 Cloudflare binding env(AI_API_KEY / AI_BASE_URL / AI_MODEL),
  // 见 server/utils/ai.ts 的 getAiConfig():env 会覆盖这里的默认值,并能在本地 dev 与部署态一致工作。
  runtimeConfig: {
    ai: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-v4-flash'
    },
    // 认证(Better Auth):NUXT_AUTH_SECRET / NUXT_AUTH_BASE_URL,或 wrangler vars/secret(BETTER_AUTH_SECRET / BETTER_AUTH_URL)
    // baseUrl 留空 → 本地 dev 自动为 localhost:4569,生产自动为部署域名;需要固定域名时再显式配置
    auth: {
      secret: '',
      baseUrl: ''
    },
    // 验证码邮件(Cloudflare Email Service — Email Sending REST API):
    // NUXT_EMAIL_FROM / NUXT_EMAIL_ACCOUNT_ID(非敏感)或 wrangler vars;token 走 env(CF_API_TOKEN_SEND_EMAIL),不放 runtimeConfig
    email: {
      from: '',
      accountId: ''
    },
    // 微支付网关(参考 docs/payment-integration.md):NUXT_MICROPAY_PID 等,或 wrangler vars/secret
    micropay: {
      pid: '',
      privateKey: '',
      publicKey: ''
    },
    // 管理员身份(兑换码等管理接口):NUXT_ADMIN_EMAIL,或 wrangler vars(ADMIN_EMAIL)
    // 留空 = 管理接口对所有人 403,保证未配置时无管理员权限可被利用
    admin: {
      email: ''
    }
  }, // 开发端口(生产部署与端口无关)。4567 在长时间反复启停后残留大量 TIME_WAIT/FIN_WAIT_2 连接,
  // 会被 get-port 误判为占用导致自动换端口与启动异常,故改用 4569 起步
  devServer: {
    port: 4569
  },

  compatibilityDate: '2026-06-30',

  // 把 wrangler 生成的 Cloudflare binding 类型(D1/R2/R2Bucket/Env)纳入 app & server 的 tsconfig
  typescript: {
    tsConfig: {
      include: ['../worker-configuration.d.ts']
    }
  },

  hooks: {
    'nitro:config'(nitroConfig) {
      // cloudflare_module 构建:改用自定义入口(额外导出 WorldGenWorkflow 类,
      // wrangler [[workflows]] 绑定要求类从主模块导出;见 entry.cloudflare.mjs)
      if (nitroConfig.preset === 'cloudflare_module') {
        nitroConfig.entry = fileURLToPath(new URL('./entry.cloudflare.mjs', import.meta.url))
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // 图标:构建时扫描源码中用到的图标并打进客户端 bundle,避免运行时回退请求在线
  // Iconify API(离线/弱网下会失败并报 [Icon] failed to load icon,图标也不渲染)
  icon: {
    clientBundle: {
      scan: true
    }
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'AI Word2World',
      short_name: 'AI W2W',
      description: 'AI 互动小说与文字冒险平台',
      lang: 'zh-CN',
      display: 'standalone',
      start_url: '/',
      theme_color: '#00DC82',
      background_color: '#ffffff',
      icons: [
        { src: '/pwa/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        { src: '/pwa/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    },
    workbox: {
      // txt 是 public 下的预设小说,预缓存后离线也能读
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,txt}'],
      // 图标.png 是 scripts/generate-pwa-icons.mjs 的 1.7MB 源图,不应进 SW 预缓存
      globIgnores: ['**/图标.png'],
      cleanupOutdatedCaches: true,
      // Nuxt SSR 没有静态 index.html(nitro 运行时渲染),precache 里不存在 "/",
      // 若保留 @vite-pwa/nuxt 默认 navigateFallback:'/' 会在导航时报 non-precached-url。
      // 显式关闭导航兜底:导航请求走网络(SSR 正常渲染),API 请求也不受 SW 影响。
      navigateFallback: undefined
    },
    devOptions: {
      enabled: false
    }
  }
})
