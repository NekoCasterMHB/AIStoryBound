// drizzle.config.ts
// Drizzle Kit 配置(仅供 `pnpm db:studio` 等工具使用)。
// 注:数据库迁移已统一为单一初始化脚本 drizzle/init.sql(幂等,由 scripts/d1-migrate.mjs 应用),
// 不再使用 drizzle-kit generate 生成增量迁移,请勿运行 `drizzle-kit generate`。
// schema 变更时同步手工维护 init.sql,见该文件头部注释的约定。
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  verbose: true,
  strict: true
})