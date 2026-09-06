// server/api/admin/cache/[id]/download.get.ts
// 缓存管理(管理端):下载单条缓存成书 zip,结构与任务下载一致
// (manifest.json + work.json + story.txt),管理员可离线核对或复用产物。
import { eq } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { worldCache } from '../../../../db/schema'
import { getSkillBucket } from '../../../../utils/r2'
import { worldSourceKey } from '../../../../utils/world-gen-pipeline'
import { SHARE_FORMAT, SHARE_VERSION } from '../../../../../shared/share-format'
import { bookZipToDoc } from '../../../../../shared/novel-v2'
import { v2ToWork } from '../../../../../shared/v2-convert'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少缓存 id' })

  const db = useD1(event)
  const row = await db.select().from(worldCache).where(eq(worldCache.id, id)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '缓存不存在或已被清理' })

  const bucket = getSkillBucket(event)
  const worldObj = await bucket.get(row.worldKey)
  if (!worldObj) throw createError({ statusCode: 410, statusMessage: '成书文件缺失(R2),无法下载' })
  const worldBytes = new Uint8Array(await worldObj.arrayBuffer())
  // v2 单轨:worldKey 为 aisb-book zip 的新缓存现场转换为 v1 结构打包;旧缓存(json)原路径解析
  let world: {
    title?: string
    author?: string | null
    overlay?: { title?: string, summary?: string }
    entities?: unknown
    conflicts?: unknown
    storyline?: unknown
    warnings?: string[]
    tokensUsed?: number
  }
  if (worldBytes.length > 4 && worldBytes[0] === 0x50 && worldBytes[1] === 0x4b) {
    try {
      const doc = bookZipToDoc(worldBytes)
      const work = v2ToWork(doc, { id: row.id })
      world = {
        title: work.title,
        author: work.author ?? null,
        overlay: work.overlay as typeof world.overlay,
        entities: work.entities,
        conflicts: work.conflicts,
        storyline: work.storyline,
        warnings: work.warnings ?? [],
        tokensUsed: row.tokensUsed
      }
    } catch {
      throw createError({ statusCode: 410, statusMessage: '成书文件损坏,无法下载' })
    }
  } else {
    try {
      world = JSON.parse(new TextDecoder().decode(worldBytes)) as typeof world
    } catch {
      throw createError({ statusCode: 410, statusMessage: '成书文件损坏,无法下载' })
    }
  }

  const sourceObj = await bucket.get(worldSourceKey(row.sourceHash))
  if (!sourceObj) throw createError({ statusCode: 410, statusMessage: '原文缺失(R2),无法打包' })
  const text = await sourceObj.text()

  const title = world.title || row.title || '未命名'
  const now = new Date().toISOString()
  const work = {
    id: row.id,
    title,
    author: world.author ?? row.author ?? undefined,
    createdAt: now,
    updatedAt: now,
    chapters: [{ title: '', content: text }],
    syncStatus: 'local' as const,
    tokensUsed: row.tokensUsed,
    entities: world.entities,
    conflicts: world.conflicts,
    warnings: world.warnings ?? [],
    overlay: world.overlay,
    storyline: world.storyline
  }
  const manifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    kind: 'game' as const,
    title,
    exportedAt: now,
    includes: ['work.json', 'story.txt']
  }
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'work.json': strToU8(JSON.stringify(work)),
    'story.txt': strToU8(text)
  }, { level: 6 })

  const safeName = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'world'
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(`${safeName}.zip`)}"; filename*=UTF-8''${encodeURIComponent(`${safeName}.zip`)}`,
    'Cache-Control': 'no-store'
  })
  return new Response(new Uint8Array(zip) as unknown as BodyInit)
})
