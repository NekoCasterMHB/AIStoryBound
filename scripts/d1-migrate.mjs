// scripts/d1-migrate.mjs
// 按文件名顺序依次对 D1 执行 drizzle 迁移(drizzle/*.sql),带幂等保护:
// - 用 __migrations 表记录已应用的迁移,重复执行自动跳过;
// - 无记录但表已存在(旧库手工应用过)时,校验文件内建的所有表均存在则视为已应用。
// 用法:
//   node scripts/d1-migrate.mjs --local     # 本地 miniflare 模拟库
//   node scripts/d1-migrate.mjs --remote    # 云端真实库
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrangler } from './wrangler.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] === '--remote' ? '--remote' : '--local'
const database = 'aistorybound'

const files = readdirSync(join(root, 'drizzle'))
  .filter(f => /^\d+_.+\.sql$/.test(f))
  .sort()

/** 执行一条 SQL 并返回结果数组(wrangler --json 输出) */
function query(sql) {
  try {
    const out = wrangler(['d1', 'execute', database, target, '--command', sql, '--json'])
    return (JSON.parse(out)[0]?.results) ?? []
  } catch {
    return []
  }
}

/** 迁移文件里 CREATE TABLE 建的所有表名 */
function tablesIn(sqlText) {
  return [...sqlText.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?/gi)].map(m => m[1])
}

// 确保记录表存在(幂等)
query('CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')

const applied = new Set(query('SELECT name FROM __migrations').map(r => r.name))
const existedTables = new Set(query('SELECT name FROM sqlite_master WHERE type=\'table\'').map(r => r.name))

for (const f of files) {
  if (applied.has(f)) {
    console.log(`[d1-migrate] skip ${f} (already applied)`)
    continue
  }
  const sqlFile = join(root, 'drizzle', f)
  const tables = tablesIn(readFileSync(sqlFile, 'utf-8'))
  if (tables.length > 0 && tables.every(t => existedTables.has(t))) {
    console.warn(`[d1-migrate] ${f} already applied (all tables exist), marking applied`)
  } else {
    console.log(`[d1-migrate] applying ${f} ...`)
    wrangler(['d1', 'execute', database, target, '--file', sqlFile], { inheritStdio: true })
  }
  query(`INSERT INTO __migrations (name, applied_at) VALUES ('${f}', '${new Date().toISOString()}')`)
  applied.add(f)
}
console.log('[d1-migrate] done')
