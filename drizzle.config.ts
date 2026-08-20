// drizzle.config.ts
// Drizzle Kit 配置:为 Cloudflare D1(兼容 SQLite 方言)生成迁移
// - `pnpm db:generate` → npx drizzle-kit generate 生成 SQL 到 ./drizzle
// - 应用迁移不用 drizzle-kit migrate,而是:
//   本地模拟: wrangler d1 migrations apply aistorybound-local(或 --local)
//   云端:     wrangler d1 migrations apply aistorybound --remote
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  verbose: true,
  strict: true
})
