// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    // 仅本地 dev 生效:通过 getPlatformProxy 在 Nitro dev server 里模拟 wrangler.toml 里的 Cloudflare binding
    // 部署时 nitro 的 cloudflare preset 提供真实 binding,两者访问方式一致(event.context.cloudflare.env)
    'nitro-cloudflare-dev'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/': { prerender: true }
  },

  // 把 wrangler 生成的 Cloudflare binding 类型(D1/R2/R2Bucket/Env)纳入 app & server 的 tsconfig
  typescript: {
    tsConfig: {
      include: ['../worker-configuration.d.ts']
    }
  },

  compatibilityDate: '2026-06-30',

  // LLM 网关默认值(构建期)。真实 Key 优先走 Cloudflare binding env(AI_API_KEY / AI_BASE_URL / AI_MODEL),
  // 见 server/utils/ai.ts 的 getAiConfig():env 会覆盖这里的默认值,并能在本地 dev 与部署态一致工作。
  runtimeConfig: {
    ai: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-v4-flash'
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
