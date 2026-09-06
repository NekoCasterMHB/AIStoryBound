// server/api/world-gen/tasks/[id]/download.get.ts
// 下载云端成书 zip(fflate 按需打包,不在 R2 存副本):
//   manifest.json(aisb-share 格式)+ work.json(完整 LocalWork,含正文与生成产物)+ story.txt(原文)。
// v2 单轨:新生成任务的 resultKey 是 aisb-book 目录 zip(作品格式 v2),此处现场转换为 v1 结构打包,
// 旧客户端/分享链路无感;旧任务遗留的 v1 world json 按 JSON 路径回退兼容。
import { and, eq, sql } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { useD1 } from '../../../../utils/d1'
import { requireUser } from '../../../../utils/authz'
import { worldCache, worldGenTasks } from '../../../../db/schema'
import { getSkillBucket } from '../../../../utils/r2'
import { SHARE_FORMAT, SHARE_VERSION } from '../../../../../shared/share-format'
import { bookZipToDoc } from '../../../../../shared/novel-v2'
import { v2ToWork } from '../../../../../shared/v2-convert'

/** 是否为 zip 字节流(PK 魔数) */
function isZipBytes(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b
}

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少任务 id' })
  const db = useD1(event)
  const row = await db.select()
    .from(worldGenTasks)
    .where(and(eq(worldGenTasks.id, id), eq(worldGenTasks.userId, sessUser.id)))
    .get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '任务不存在' })
  if (row.status !== 'completed' || !row.resultKey) {
    throw createError({ statusCode: 409, statusMessage: '任务尚未完成,无法下载' })
  }

  const bucket = getSkillBucket(event)
  const resultObj = await bucket.get(row.resultKey)
  if (!resultObj) throw createError({ statusCode: 410, statusMessage: '成书缓存缺失,请重新生成' })
  const resultBytes = new Uint8Array(await resultObj.arrayBuffer())

  // v2 单轨:resultKey 为 aisb-book zip → 现场转换为 v1 work 结构;旧任务(json)走回退解析
  let world: {
    title?: string
    author?: string | null
    overlay?: { title?: string, summary?: string }
    entities?: unknown
    conflicts?: unknown
    storyline?: unknown
    characterArcs?: unknown
    warnings?: string[]
    tokensUsed?: number
    mode?: string
  }
  if (isZipBytes(resultBytes)) {
    try {
      const doc = bookZipToDoc(resultBytes)
      const work = v2ToWork(doc, { id: row.id })
      world = {
        title: work.title,
        author: work.author ?? null,
        overlay: work.overlay as typeof world.overlay,
        entities: work.entities,
        conflicts: work.conflicts,
        storyline: work.storyline,
        characterArcs: work.characterArcs,
        warnings: work.warnings ?? [],
        tokensUsed: row.keySource === 'user' ? undefined : row.tokensUsed,
        mode: row.mode
      }
    } catch {
      throw createError({ statusCode: 410, statusMessage: '成书缓存损坏,请重新生成' })
    }
  } else {
    try {
      world = JSON.parse(new TextDecoder().decode(resultBytes)) as typeof world
    } catch {
      throw createError({ statusCode: 410, statusMessage: '成书缓存损坏,请重新生成' })
    }
  }

  // 原文(拉取的任务同样可下;源文件按 hash 全站共享存储)
  const sourceObj = await bucket.get(row.sourceKey)
  if (!sourceObj) throw createError({ statusCode: 410, statusMessage: '原文缺失,无法打包' })
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
    encoding: row.encoding ?? undefined,
    syncStatus: 'local' as const,
    // 自建 key 任务不写 tokensUsed:消耗的是用户自己 key 的钱,与平台 token 无关,书架作品卡不应显示
    tokensUsed: row.keySource === 'user' ? undefined : (world.tokensUsed ?? row.tokensUsed),
    entities: world.entities,
    conflicts: world.conflicts,
    warnings: world.warnings ?? [],
    overlay: world.overlay,
    storyline: world.storyline,
    characterArcs: world.characterArcs
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

  // 下载计数(best-effort,不阻塞下载)
  try {
    await db.update(worldCache)
      .set({ downloads: sql`${worldCache.downloads} + 1`, updatedAt: new Date() })
      .where(and(eq(worldCache.sourceHash, row.sourceHash), eq(worldCache.mode, row.mode)))
      .run()
  } catch {
    // 计数失败不影响下载
  }

  const safeName = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'world'
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(`${safeName}.zip`)}"; filename*=UTF-8''${encodeURIComponent(`${safeName}.zip`)}`,
    'Cache-Control': 'no-store'
  })
  return new Response(new Uint8Array(zip) as unknown as BodyInit)
})
