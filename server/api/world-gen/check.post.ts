// server/api/world-gen/check.post.ts
// 相同 txt 查重:按内容 sha-256 + 模式查共享缓存。
// 命中时返回缓存信息(含拉取价 = 记录消耗的一半),客户端弹「拉取已有世界 / 重新生成」选择。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { worldCache } from '../../db/schema'
import { cacheHalfCost } from '../../../shared/world-gen-task'
import type { WorldCacheHit } from '../../../shared/world-gen-task'
import { isValidSourceHash } from '../../utils/world-gen-dto'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = await readBody<{ hash?: string, mode?: string }>(event).catch(() => ({}) as { hash?: string, mode?: string })
  const hash = String(body.hash ?? '').toLowerCase()
  const mode = body.mode === 'eco' ? 'eco' : 'full'
  if (!isValidSourceHash(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'hash 必须是 sha-256 十六进制' })
  }

  const row = await useD1(event).select()
    .from(worldCache)
    .where(and(eq(worldCache.sourceHash, hash), eq(worldCache.mode, mode)))
    .get()
  if (!row) return { hit: null as WorldCacheHit | null }

  const hit: WorldCacheHit = {
    cacheId: row.id,
    sourceHash: row.sourceHash,
    title: row.title,
    author: row.author,
    mode: row.mode === 'eco' ? 'eco' : 'full',
    tokensUsed: row.tokensUsed,
    halfCost: cacheHalfCost(row.tokensUsed),
    createdAt: row.createdAt.toISOString()
  }
  return { hit }
})
