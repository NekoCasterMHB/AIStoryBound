// scripts/build-skill-zips.mjs
// 把 skills/<类别>/ 下的 SKILL.md + reference.md + LICENSE.txt 打成标准 agent skill zip
// (根目录含 SKILL.md,与 server 端 parseSkillZip 的校验规则一致)。
// 用法:node scripts/build-skill-zips.mjs
// 产物:<类别目录>/<类别>-skill.zip;固定文件时间戳保证可重复构建。
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync, unzipSync } from 'fflate'
import { parseSkillMd } from '../shared/ai-skills'

const ROOT = join(import.meta.dirname, '..', 'skills')
const FIXED_MTIME = new Date('2026-08-26T00:00:00Z')

const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d{2}-/.test(d.name))
  .sort((a, b) => a.name.localeCompare(b.name))

let fail = 0
for (const dir of dirs) {
  const dirPath = join(ROOT, dir.name)
  const files = readdirSync(dirPath).filter(f => !f.endsWith('.zip'))
  if (files.length === 0) continue

  // 打包:zip 内所有文件平铺在根目录(SKILL.md 在根,reference/LICENSE 并列)
  const inputs = {}
  for (const f of files) {
    inputs[f] = [new Uint8Array(readFileSync(join(dirPath, f))), { mtime: FIXED_MTIME }]
  }
  const zipName = `${dir.name}-skill.zip`
  writeFileSync(join(dirPath, zipName), zipSync(inputs, { level: 6 }))

  // 校验 1:可解压且含 SKILL.md
  const unzipped = unzipSync(readFileSync(join(dirPath, zipName)))
  const entries = Object.keys(unzipped)
  const hasSkillMd = entries.some(p => /(^|\/)SKILL\.md$/i.test(p))
  if (!hasSkillMd) {
    console.error(`  ✘ ${zipName}: 缺少 SKILL.md`)
    fail++
    continue
  }

  // 校验 2:SKILL.md 能被 parseSkillMd 解析(key/name/desc/正文)
  const skillMdPath = entries.find(p => /(^|\/)SKILL\.md$/i.test(p))
  let parsed
  try {
    parsed = parseSkillMd(new TextDecoder().decode(unzipped[skillMdPath]))
  } catch (e) {
    console.error(`  ✘ ${zipName}: parseSkillMd 失败: ${e.message}`)
    fail++
    continue
  }

  const size = statSync(join(dirPath, zipName)).size
  console.log(`  ✔ ${zipName} (${(size / 1024).toFixed(1)}KB) → key=${parsed.key}, name=${parsed.name}, 正文 ${parsed.body.length} 字, 文件数 ${entries.length}`)
}

process.exit(fail ? 1 : 0)
