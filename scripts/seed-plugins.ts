// scripts/seed-plugins.ts
// 功能插件上架(平台官方商品):把内置的啵啵贝适配器作为功能插件写入 D1 的 plugin_products。
// 幂等:已存在则更新(名称/描述/价格/状态),可重复执行。
// 用法: pnpm seed:plugins:local | pnpm seed:plugins:remote
import { wrangler } from './wrangler.mjs'

const target = process.argv.includes('--remote') ? '--remote' : '--local'
const dbName = 'aiword2world'

/** 平台官方功能插件清单(新增插件在此追加;price=0 表示限时免费) */
const PLUGINS = [
  {
    id: 'sosexy',
    name: '啵啵贝智能联动',
    desc: '让 AI 在剧情中自主操作啵啵贝智能玩具(吮吸/震动/微电流)。可设置强度/时长上限、AI 开关,并切换模拟测试与真实蓝牙连接。',
    price: 0,
    icon: '🫧',
    status: 'approved',
    featured: 1
  }
]

function sqlStr(v: string | number | null | undefined): string {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, '\'\'')}'`
}

async function main() {
  console.log(`[seed-plugins] ${target} 上架 ${PLUGINS.length} 个功能插件 ...`)
  for (const p of PLUGINS) {
    const esc = sqlStr(p.id)
    // wrangler() 返回 stdout 字符串;banner 混在 JSON 前面,从第一个 '[' 截取
    const out = wrangler(['d1', 'execute', dbName, target, '--command',
      `SELECT count(*) AS n FROM plugin_products WHERE id = ${esc}`])
    const jsonStart = out.indexOf('[')
    const count = Number(JSON.parse(jsonStart >= 0 ? out.slice(jsonStart) : '[]')?.[0]?.results?.[0]?.n ?? 0)
    if (count > 0) {
      await wrangler(['d1', 'execute', dbName, target, '--command',
        `UPDATE plugin_products SET name=${sqlStr(p.name)}, \`desc\`=${sqlStr(p.desc)}, price=${p.price}, icon=${sqlStr(p.icon)}, status=${sqlStr(p.status)}, featured=${p.featured}, updated_at=strftime('%s','now')*1000 WHERE id=${esc}`])
      console.log(`  ↻ 更新 ${p.id}(${p.name})`)
    } else {
      await wrangler(['d1', 'execute', dbName, target, '--command',
        `INSERT INTO plugin_products (id, name, \`desc\`, price, icon, status, featured, purchase_count, created_at, updated_at)
         VALUES (${esc}, ${sqlStr(p.name)}, ${sqlStr(p.desc)}, ${p.price}, ${sqlStr(p.icon)}, ${sqlStr(p.status)}, ${p.featured}, 0, strftime('%s','now')*1000, strftime('%s','now')*1000)`])
      console.log(`  + 上架 ${p.id}(${p.name})`)
    }
  }
  console.log('[seed-plugins] done')
}

main().catch((e) => {
  console.error('[seed-plugins] 失败:', e)
  process.exit(1)
})
