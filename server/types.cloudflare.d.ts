// server/types.cloudflare.d.ts
// 让 server 端 TS 拿到 Cloudflare binding 类型(D1/ASSETS 静态资产/Env)
// worker-configuration.d.ts 由 `wrangler types` 生成(wrangler.toml 变更后需重新生成)
import type {} from '../worker-configuration.d.ts'
