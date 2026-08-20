// server/api/novels/index.post.ts
// 上传小说:TXT → 解析(编码/清洗/切章)→ 入库章节(D1)→ 以正文为上下文交给 LLM 生成世界观速览
// (不保存原始文件,按要求直接把内容作为上下文传给 AI)
import { parseNovelBytes } from '../../utils/novel-parser'
import { createNovel, insertChapters, updateNovel } from '../../utils/db'
import { structuredOutput } from '../../utils/ai'
import { uuid } from '../../../shared/novel'
import type { ChapterSegment } from '../../../shared/novel'

/** 作为 AI 上下文的正文上限(字符)。超出则取开头,保证单次请求体积可控。 */
const AI_CONTEXT_CHAR_LIMIT = 60000

/** 把解析出的章节拼成给 LLM 的上下文(带章节标题,前 N 章优先) */
function buildAIContext(title: string, chapters: ChapterSegment[]): string {
  let out = `《${title}》\n`
  let used = out.length
  for (const ch of chapters) {
    const block = `\n【${ch.title || `第${chapters.indexOf(ch) + 1}部分`}】\n${ch.content}\n`
    if (used + block.length > AI_CONTEXT_CHAR_LIMIT) {
      // 剩余空间还能塞点则截断,否则停
      const remain = AI_CONTEXT_CHAR_LIMIT - used
      if (remain > 80) out += block.slice(0, remain)
      break
    }
    out += block
    used += block.length
  }
  return out
}

export default defineEventHandler(async (event) => {
  const form = await readMultipartFormData(event)
  if (!form || form.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No file uploaded' })
  }

  const file = form.find((f) => f.name === 'file') ?? form[0]
  if (!file || !file.data) {
    throw createError({ statusCode: 400, statusMessage: 'No file data' })
  }

  const filename = (file.filename || 'novel.txt')
  const bytes = new Uint8Array(file.data)
  const userId = 'anon' // TODO(用户系统 §4.1):接入认证后改为真实 userId

  // 解析(编码检测 + 清洗 + 章节切分)
  const result = parseNovelBytes(bytes, filename)
  if (result.chapters.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Empty or unparseable file' })
  }

  const novelId = uuid()

  // 建记录(status=parsing)
  await createNovel(event, {
    id: novelId,
    user_id: userId,
    title: result.title,
    author: null,
    source_format: 'txt',
    encoding: result.encoding,
    status: 'parsing',
    parse_progress: 30
  })

  try {
    // 1) 章节入库(D1)
    const chapters = result.chapters.map((c, i) => ({ idx: i, title: c.title, content: c.content }))
    await insertChapters(event, novelId, chapters)

    // 2) 以正文为上下文,让 LLM 产出世界观速览(结构化结果存 world_state)
    const context = buildAIContext(result.title, result.chapters)
    const world = await structuredOutput<{ title: string, genre: string, summary: string, characters: { name: string, role: string, description: string }[] }>(
      event,
      [{ role: 'user', content: `这是小说正文,请分析并按要求输出世界观速览:\n\n${context}` }],
      {
        schemaHint: `{
  "title": "小说标题(string)",
  "genre": "题材/类型(string)",
  "summary": "一句话简介(string)",
  "characters": [{"name":"角色名(string)","role":"主角/配角/反派(string)","description":"一句话描述(string)"}]
}`,
        maxTokens: 1200,
        timeoutMs: 60000
      }
    )

    await updateNovel(event, novelId, {
      title: world.title || result.title,
      chapter_count: chapters.length,
      status: 'ready',
      parse_progress: 100,
      world_state: JSON.stringify(world)
    })
  } catch (e: any) {
    await updateNovel(event, novelId, { status: 'failed', error: e?.message ?? String(e) })
    throw createError({ statusCode: 500, statusMessage: `Parse/AI failed: ${e?.message ?? e}` })
  }

  return {
    id: novelId,
    title: result.title,
    encoding: result.encoding,
    status: 'ready',
    chapter_count: result.chapters.length
  }
})
