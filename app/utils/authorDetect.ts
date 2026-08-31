// app/utils/authorDetect.ts
// 生成管线第 0 步:识别作者。正文(正则快速路径 → AI 判定)未果时,按书名经 /api/ai/search
// 联网检索,再由 AI 从结果片段中确认。AI 调用走既有中继(与生成共用密钥/配额)。
import { detectAuthorFromFrontMatter, isAnonymousAuthor } from '#shared/novel'
import type { ChapterSegment } from '#shared/novel'
import { JSON_ONLY_SYSTEM } from '#shared/world-build'
import { aiChatJson, CancelledError } from './aiRelay'
import type { LiveTokenInfo } from './aiRelay'

const AUTHOR_SCHEMA = `{"author": "作者名或笔名,无法确定填 null"}`

export interface AuthorDetectResult {
  author: string | null
  tokensUsed: number
  /** 是否已执行联网检索(即使未确认) */
  searched: boolean
}

/** 书名 → 检索词:去掉书名号/空白;太泛(未命名/无题等)不检索 */
function searchableTitle(title: string): string | null {
  const t = (title ?? '').replace(/[《》「」\s]/g, '').trim()
  if (!t || t.length < 2 || /^(未命名|新建|无题)/.test(t)) return null
  return t
}

function authorFromAi(data: { author?: unknown } | null | undefined): string | null {
  const name = typeof data?.author === 'string' ? data.author.trim() : ''
  return name && !isAnonymousAuthor(name) ? name : null
}

const WEB_SEARCH_SNIPPET_LIMIT = 6

/**
 * 三步识别:
 * 1. 正则解析书名页/前言(作者:xxx、xxx 著等,零成本);
 * 2. 未果 → AI 看前言 + 第一章开头判定;
 * 3. 仍未果 → 按书名联网检索 → AI 从检索结果片段确认(多在"不确定则不输出")。
 * 全程失败返回 author=null(书架显示"佚名",用户可在编辑页手动补充)。
 * signal 触发取消时抛 CancelledError。
 */
export async function detectAuthor(
  title: string,
  frontMatter: string,
  chapters: ChapterSegment[],
  onLive?: (info: LiveTokenInfo) => void,
  signal?: AbortSignal
): Promise<AuthorDetectResult> {
  const out: AuthorDetectResult = { author: null, tokensUsed: 0, searched: false }

  // 1) 正则快速路径
  out.author = detectAuthorFromFrontMatter(frontMatter)
  if (out.author) return out

  // 2) AI 判定:前言 + 第一章开头(作者署名的常见位置,正文其余章节不含作者信息)
  const textSnip = [frontMatter.slice(0, 2000), chapters[0]?.content.slice(0, 1500) ?? '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 3000)
  const aiRes = await aiChatJson<{ author?: unknown }>([
    { role: 'system', content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${AUTHOR_SCHEMA}` },
    {
      role: 'user',
      content: `小说《${title}》的开头内容如下(书名页/前言 + 第一章开头)。请依据文本判断作者:\n`
        + '- 文本明确给出作者时(如"作者:xxx""xxx 著"或书名旁署"xxx 著"),输出作者名(原名或笔名);\n'
        + '- 无法确定时输出 null;不要编造。\n'
        + `文本:\n${textSnip}`
    }
  ], { maxTokens: 200, temperature: 0, purpose: 'worldGen' }, { onLive, signal })
  if (signal?.aborted) throw new CancelledError()
  // 失败(如 502 非 JSON)也已产生输出,如实入账
  out.tokensUsed += aiRes.usage?.totalTokens ?? 0
  if (aiRes.ok && aiRes.data) {
    out.author = authorFromAi(aiRes.data)
    if (out.author) return out
  }

  // 3) 联网检索:正文没有作者信息 → 按书名搜索,AI 从结果片段确认
  const q = searchableTitle(title)
  if (q) {
    out.searched = true
    const res = await $fetch<{ results: { source: string, title: string, snippet: string }[] }>(
      '/api/ai/search',
      { query: { q }, signal }
    ).catch(() => null)
    if (signal?.aborted) throw new CancelledError()
    const results = res?.results?.filter(r => r.snippet || r.title) ?? []
    if (results.length > 0) {
      const list = results.slice(0, WEB_SEARCH_SNIPPET_LIMIT)
        .map((r, i) => `${i + 1}. [${r.source}] ${r.title}\n${r.snippet}`)
        .join('\n\n')
      const webRes = await aiChatJson<{ author?: unknown }>([
        { role: 'system', content: `${JSON_ONLY_SYSTEM}\n输出结构必须满足:\n${AUTHOR_SCHEMA}` },
        {
          role: 'user',
          content: `小说《${title}》的网络搜索结果如下。请判断这本书的作者:\n`
            + '- 只依据结果中明确署名的信息(如"作者:xxx""xxx 著")判断;多条结果一致时采用;\n'
            + '- 结果与本书无关、署名相互矛盾或无法确定时输出 null;不要编造。\n'
            + `搜索结果:\n${list}`
        }
      ], { maxTokens: 200, temperature: 0, purpose: 'worldGen' }, { onLive, signal })
      if (signal?.aborted) throw new CancelledError()
      out.tokensUsed += webRes.usage?.totalTokens ?? 0
      if (webRes.ok && webRes.data) {
        out.author = authorFromAi(webRes.data)
      }
    }
  }
  return out
}
