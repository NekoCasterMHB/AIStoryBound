// server/api/ai/skill-import.post.ts
// AI Skill 导入中继:浏览器端用户粘贴 SKILL.md 直链(GitHub raw / jsdelivr 等)
// → 服务器代为下载(绕开浏览器 CORS 限制),并跟随正文里的同级引用文件二次抓取(多文件 skill,
//  如 reference.md / resources 下说明)→ 返回主正文 + 附件列表,由客户端解析 frontmatter 后存 IndexedDB。
// 引用解析逻辑(extractSkillRefs / resolveSkillRefUrl)在 shared 里,与前端共用。
// 仅限 http(s),限制体积与跟随数量防止滥用。
import { requireUser } from '../../utils/authz'
import { extractSkillRefs, resolveSkillRefUrl } from '../../../shared/ai-skills'

const MAIN_MAX_BYTES = 256 * 1024 // 单个文件上限
const TOTAL_MAX_BYTES = 512 * 1024 // 主正文 + 附件合计上限
const MAX_FILES = 8 // 最多跟随抓取几个同级文件

interface ImportFile { name: string, text: string }

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = await readBody<{ url?: string }>(event).catch(() => ({} as { url?: string }))
  const url = (body?.url ?? '').trim()
  if (!url) throw createError({ statusCode: 400, statusMessage: '缺少下载链接' })
  if (!/^https?:\/\//i.test(url)) {
    throw createError({ statusCode: 400, statusMessage: '链接必须是 http(s) 直链' })
  }

  let main: string
  try {
    main = await fetchText(url)
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: `下载失败: ${(e as Error).message}` })
  }

  // 跟随正文里的同级文件引用(失败不致命,跳过即可)
  const files: ImportFile[] = []
  const seen = new Set<string>()
  const totalBytes = () => main.length + files.reduce((n, f) => n + f.text.length, 0)
  for (const rel of extractSkillRefs(main)) {
    if (files.length >= MAX_FILES || totalBytes() >= TOTAL_MAX_BYTES) break
    const abs = resolveSkillRefUrl(url, rel)
    if (!abs || seen.has(abs)) continue
    seen.add(abs)
    try {
      const text = await fetchText(abs)
      if (totalBytes() + text.length <= TOTAL_MAX_BYTES) {
        files.push({ name: rel, text })
      }
    } catch {
      // 单个引用抓取失败不致命
    }
  }

  return { url, text: main, files }
})

async function fetchText(u: string): Promise<string> {
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text().catch(() => { throw new Error('响应不是文本') })
  if (!text) throw new Error('内容是空文件')
  if (text.length > MAIN_MAX_BYTES) throw new Error('文件超过 256KB 限制')
  return text
}