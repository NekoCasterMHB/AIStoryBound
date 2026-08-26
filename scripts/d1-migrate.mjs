// scripts/d1-migrate.mjs
// 将统一的初始化脚本 drizzle/init.sql 应用到 D1 数据库(本地 Miniflare 模拟库或云端真实库)。
// init.sql 内所有语句均幂等(IF NOT EXISTS),可对全新库执行,也可对已存在的库重复执行,
// 因此无需按文件记账;应用成功后顺手清理早期多文件迁移方案遗留的 __migrations 记账表。
// 用法:
//   node scripts/d1-migrate.mjs --local     # 本地 miniflare 模拟库
//   node scripts/d1-migrate.mjs --remote    # 云端真实库
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrangler } from './wrangler.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] === '--remote' ? '--remote' : '--local'
const database = 'aiword2world'

console.log(`[d1-migrate] applying ${database} (${target}) from drizzle/init.sql ...`)
wrangler(['d1', 'execute', database, target, '--file', join(root, 'drizzle', 'init.sql')], { inheritStdio: true })
wrangler(['d1', 'execute', database, target, '--command', 'DROP TABLE IF EXISTS __migrations'])
console.log('[d1-migrate] done')