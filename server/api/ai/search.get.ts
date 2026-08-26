// server/api/ai/search.get.ts
// 通用联网检索(免密钥,供生成管线"正文未识别到作者 → 按书名联网检索"等场景):
//   ① 中文维基百科 API(稳定 JSON,引言常含"是 XXX 所作的小说")
//   ② DuckDuckGo HTML(召回广)兜底
// 检索词只含书名,不含正文;返回结构化片段,由浏览器侧交给 AI 判断,不在此落库。
import { requireUserId } from '../../utils/authz'

const WIKI_API = 'https://zh.wikipedia.org/w/api.php'
const DDG_HTML = 'https://html.duckduckgo.com/html/'
const FETCH_TIMEOUT_MS = 7000

interface SearchResult {
  source: 'wikipedia' | 'duckduckgo'
  title: string
  snippet: string
}

const stripHtml = (s: string) => s
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

export default defineEventHandler(async (event) => {
  await requireUserId(event)
  const q = String(getQuery(event).q ?? '').replace(/[《》「」]/g, '').trim()
  if (!q || q.length < 2 || q.length > 60) return { results: [] }

  const results: SearchResult[] = []

  // 1) 中文维基:标题搜索 → 前 2 条条目正文引言
  try {
    const searchRes = await fetch(
      `${WIKI_API}?action=query&list=search&format=json&utf8=1&srlimit=4&srsearch=${encodeURIComponent(`${q} 小说`)}`,
      {
        headers: { 'User-Agent': 'AIWord2World/1.1 (world generation)' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      }
    )
    if (searchRes.ok) {
      const data = await searchRes.json() as { query?: { search?: { title: string }[] } }
      const titles = (data.query?.search ?? []).slice(0, 2).map(s => s.title)
      if (titles.length > 0) {
        const extRes = await fetch(
          `${WIKI_API}?action=query&prop=extracts&exintro=1&explaintext=1&format=json&utf8=1&titles=${titles.map(t => encodeURIComponent(t)).join('|')}`,
          {
            headers: { 'User-Agent': 'AIWord2World/1.1 (world generation)' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
          }
        )
        if (extRes.ok) {
          const ext = await extRes.json() as { query?: { pages?: Record<string, { title?: string, extract?: string }> } }
          for (const p of Object.values(ext.query?.pages ?? {})) {
            if (!p.extract) continue
            results.push({ source: 'wikipedia', title: p.title ?? q, snippet: stripHtml(p.extract).slice(0, 400) })
          }
        }
      }
    }
  } catch {
    // 维基不可达则跳过,不阻塞整个检索
  }

  // 2) DuckDuckGo HTML 检索(解析 result__a / result__snippet)
  try {
    const ddgRes = await fetch(`${DDG_HTML}?q=${encodeURIComponent(`${q} 作者`)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (ddgRes.ok) {
      const html = await ddgRes.text()
      const anchors = [...html.matchAll(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 5)
      const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
      for (const [i, m] of anchors.entries()) {
        const title = stripHtml(m[1] ?? '')
        if (!title) continue
        results.push({ source: 'duckduckgo', title, snippet: stripHtml(snippets[i]?.[1] ?? '').slice(0, 300) })
      }
    }
  } catch {
    // DDG 失败则跳过
  }

  // 标题归一化去重(维基与 DDG 可能命中同一条目),总量限制
  const seen = new Set<string>()
  const uniq = results.filter((r) => {
    const key = r.title.replace(/\s+/g, '')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { results: uniq.slice(0, 8) }
})