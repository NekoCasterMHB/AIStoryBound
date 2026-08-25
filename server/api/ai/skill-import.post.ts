// server/api/ai/skill-import.post.ts
// AI Skill 导入中继:浏览器端用户粘贴技能 JSON 直链 → 服务器代为下载(绕开浏览器 CORS 限制)
// → 返回解析后的 JSON,由客户端校验并存入本地 IndexedDB。浏览器的 fetch 对多数直链(如 GitHub raw)
// 会因 CORS 被拒,统一走服务端下载;仅限 http(s),限制体积防止滥用。
import { requireUser } from '../../utils/authz'

const MAX_BYTES = 256 * 1024

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = await readBody<{ url?: string }>(event).catch(() => ({}) as { url?: string })
  const url = (body?.url ?? '').trim()
  if (!url) throw createError({ statusCode: 400, statusMessage: '缺少下载链接' })
  if (!/^https?:\/\//i.test(url)) {
    throw createError({ statusCode: 400, statusMessage: '链接必须是 http(s) 直链' })
  }

  let upstream: Response
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: `下载失败: ${(e as Error).message}` })
  }
  if (!upstream.ok) {
    throw createError({ statusCode: 502, statusMessage: `下载失败 (HTTP ${upstream.status})` })
  }
  const text = await upstream.text().catch(() => '')
  if (text.length > MAX_BYTES) {
    throw createError({ statusCode: 400, statusMessage: '技能文件超过 256KB 限制' })
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw createError({ statusCode: 400, statusMessage: '链接内容不是合法 JSON,请检查文件格式' })
  }
})
