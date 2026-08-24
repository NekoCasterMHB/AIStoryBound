// scripts/seed-presets.ts
// 预置小说元数据同步:正文随站点部署为静态资源(public/txt/*.txt,由 wrangler [assets] 托管,
// 接口经 ASSETS binding 直读),本脚本只负责把元数据解析结果写入 D1 的 preset_novels 表。
// 元数据自动解析(首行《标题》作者:XXX、首个短段落作推荐语);如需精细控制,
// 在 public/txt/index.json 提供按文件名(去扩展名)为 key 的覆盖:
//   { "巴掌印": { "genre": "现代言情", "description": "...", "coverEmoji": "🔍", "featured": 1, "sortOrder": 1 } }
// 用法: pnpm seed:presets:local | pnpm seed:presets:remote [--dir=public/txt]
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrangler } from './wrangler.mjs'
import { parseNovelBytes } from '../server/utils/novel-parser'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv.includes('--remote') ? '--remote' : '--local'
const dirArg = process.argv.find(a => a.startsWith('--dir='))
const srcDir = join(root, dirArg ? dirArg.slice(6) : 'public/txt')
const dbName = 'aiSpankWorld'

interface MetaOverride {
  title?: string
  author?: string | null
  genre?: string | null
  description?: string | null
  coverEmoji?: string | null
  featured?: number
  sortOrder?: number
}

function runWrangler(args: string[], opts?: { inheritStdio?: boolean }) {
  wrangler(args, opts)
}

function sqlStr(v: string | null | undefined): string {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, '\'\'')}'`
}

const files = readdirSync(srcDir).filter(f => /\.(txt|text)$/i.test(f)).sort()
if (files.length === 0) {
  console.error(`[seed-presets] 目录中没有 TXT: ${srcDir}`)
  process.exit(1)
}

// 可选覆盖(docs/txt/index.json,按 id 为 key)
let overrides: Record<string, MetaOverride> = {}
try {
  overrides = JSON.parse(readFileSync(join(srcDir, 'index.json'), 'utf-8'))
} catch (e) {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code !== 'ENOENT') {
    console.warn(`[seed-presets] ${join(srcDir, 'index.json')} 解析失败,将使用自动解析元数据: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const rows = files.map((f) => {
  const bytes = new Uint8Array(readFileSync(join(srcDir, f)))
  const parsed = parseNovelBytes(bytes, f)
  const id = f.replace(/\.(txt|text)$/i, '')
  const ov = overrides[id] ?? {}

  // 从原文自动解析标题/作者/推荐语
  const decoded = new TextDecoder(parsed.encoding).decode(bytes).replace(/^\uFEFF/, '')
  // 首行常为书名/作者行,标题只从首行的《》内取并去掉【标签】,如 《撩愈【SP 1V1】》 → 撩愈;
  // 首行没有《》则回退用文件名(避免误把正文里的《…》当标题)
  const firstLine = decoded.split(/\r?\n/, 1)[0]
  const rawTitle = firstLine.match(/《([^《》]+)》/)?.[1]?.trim() ?? parsed.title
  const title = rawTitle.replace(/\s*【[^】]*】\s*/g, '').trim() || rawTitle
  const author = ov.author !== undefined
    ? ov.author
    : decoded.match(/作者\s*[:：]\s*([^\s【】[\]、,，。;；]+)/)?.[1]?.trim() ?? null
  // 推荐语:跳过标题/作者行,取首个 5~120 字的短段落(再跳过"作者:…"与章标题行)
  const body = (decoded.match(/《[^》]+》/) || decoded.match(/作者\s*[:：]/))
    ? decoded.replace(/^\s*\S[^\n]*\n/, '') // 去掉第一行(书名/作者行)
    : decoded
  const descLine = (p: string) => p.replace(/\n/g, ' ').trim()
  const description = ov.description !== undefined
    ? ov.description
    : (body.split(/\n{2,}/).find((p) => {
        const t = descLine(p)
        return t.length >= 5 && t.length <= 120
          && !t.includes('《') && !/^作者\s*[:：]/.test(t)
          && !/^(?:第\s*[0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾]+\s*[章节回卷部集篇]|楔子|序章|序言|引言|尾声|番外|后记|终章)/.test(t)
      }) ?? null)

  return {
    id,
    title: title.slice(0, 200),
    author: author ? String(author).slice(0, 100) : null,
    genre: ov.genre ?? null,
    description: description ? String(description).slice(0, 500) : null,
    coverEmoji: ov.coverEmoji ?? null,
    storageKey: `txt/${id}.txt`,
    encoding: parsed.encoding,
    chapterCount: parsed.chapters.length,
    charCount: parsed.totalChars,
    featured: ov.featured ?? 1,
    sortOrder: ov.sortOrder ?? 0
  }
})

// 1) 写 D1(ON CONFLICT 幂等更新;download_count/created_at 保留)
// 正文不再上传 R2:txt 文件放在 public/txt/ 随站点部署,下载接口按 storage_key 约定直读静态资源
const values = rows.map(r =>
  `(${sqlStr(r.id)}, ${sqlStr(r.title)}, ${sqlStr(r.author)}, ${sqlStr(r.genre)}, ${sqlStr(r.description)}, ${sqlStr(r.coverEmoji)}, ${sqlStr(r.storageKey)}, ${sqlStr(r.encoding)}, ${r.chapterCount}, ${r.charCount}, ${r.featured}, ${r.sortOrder}, 0, ${sqlStr(new Date().toISOString())})`
).join(',\n')
const sql = `INSERT INTO preset_novels (id, title, author, genre, description, cover_emoji, storage_key, encoding, chapter_count, char_count, featured, sort_order, download_count, created_at)\nVALUES\n${values}\nON CONFLICT(id) DO UPDATE SET\n  title = excluded.title,\n  author = excluded.author,\n  genre = excluded.genre,\n  description = excluded.description,\n  cover_emoji = excluded.cover_emoji,\n  storage_key = excluded.storage_key,\n  encoding = excluded.encoding,\n  chapter_count = excluded.chapter_count,\n  char_count = excluded.char_count,\n  featured = excluded.featured,\n  sort_order = excluded.sort_order;\n`

const tmp = mkdtempSync(join(tmpdir(), 'seed-presets-'))
const sqlFile = join(tmp, 'insert.sql')
writeFileSync(sqlFile, sql, 'utf-8')
console.log(`[seed-presets] d1 execute (${rows.length} rows)`)
runWrangler(['d1', 'execute', dbName, target, '--file', sqlFile])
rmSync(tmp, { recursive: true, force: true })

console.log(`[seed-presets] done: ${rows.length} novels`)
for (const r of rows) {
  console.log(`  - ${r.title} (${r.genre ?? '题材未设置'})`
    + `${r.description ? ` 「${r.description.slice(0, 30)}${r.description.length > 30 ? '…' : ''}」` : ''}`)
}
