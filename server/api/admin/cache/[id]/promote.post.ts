// server/api/admin/cache/[id]/promote.post.ts
// 缓存管理(管理端):把单条缓存成书「添加到推荐书架」。
// 预置小说资源分两处:源 txt 与成书 world JSON 复制到 R2 预置区(preset-txt/<id>.txt / preset-worlds/<id>.json),
// 并插入 preset_novels 记录(featured=1);预置读取接口(下载/世界)在静态资源缺失时回退读 R2(见各接口)。
// 幂等:同一缓存行重复 promote 用主键冲突更新,不重复建书。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../../../utils/d1'
import { requireAdmin } from '../../../../utils/authz'
import { presetNovels, worldCache } from '../../../../db/schema'
import { getSkillBucket } from '../../../../utils/r2'
import { worldSourceKey } from '../../../../utils/world-gen-pipeline'

/** 预置 txt 的 R2 回退 key(静态 public/txt 缺失时读取) */
export function presetTxtR2Key(presetId: string): string {
  return `preset-txt/${presetId}.txt`
}

/** 预置世界 JSON 的 R2 回退 key(静态 public/worlds 缺失时读取) */
export function presetWorldR2Key(presetId: string): string {
  return `preset-worlds/${presetId}.json`
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少缓存 id' })

  const db = useD1(event)
  const row = await db.select().from(worldCache).where(eq(worldCache.id, id)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: '缓存不存在或已被清理' })

  const bucket = getSkillBucket(event)
  // 源 txt(与缓存同 hash 的全站共享原文)与成书 world JSON 都已存在 R2,复制到预置区
  const sourceObj = await bucket.get(worldSourceKey(row.sourceHash))
  if (!sourceObj) throw createError({ statusCode: 410, statusMessage: '源 txt 缺失(R2),无法加入推荐书架' })
  const worldObj = await bucket.get(row.worldKey)
  if (!worldObj) throw createError({ statusCode: 410, statusMessage: '成书文件缺失(R2),无法加入推荐书架' })

  // 预置小说 id 用缓存 id 前缀,保证唯一且可追溯到缓存行
  const presetId = `wc-${row.id}`
  const txtKey = presetTxtR2Key(presetId)
  const worldKey = presetWorldR2Key(presetId)
  const sourceBytes = new Uint8Array(await sourceObj.arrayBuffer())
  const worldBytes = new Uint8Array(await worldObj.arrayBuffer())
  await Promise.all([
    bucket.put(txtKey, sourceBytes),
    bucket.put(worldKey, worldBytes)
  ])

  // 元信息尽量取自缓存行;summary 取自成书 overlay(若存在),charCount 取源 txt 长度(推荐书架卡片显示字数)
  let summary: string | null = null
  let charCount = 0
  try {
    const parsed = JSON.parse(new TextDecoder().decode(worldBytes)) as { overlay?: { summary?: string }, summary?: string }
    summary = parsed.overlay?.summary ?? parsed.summary ?? null
  } catch {
    // 成书 JSON 已在上方验证过可读,这里只做 summary 增强,失败忽略
  }
  try {
    charCount = new TextDecoder().decode(sourceBytes).length
  } catch {
    // 字数统计失败不影响入库
  }

  const now = new Date().toISOString()
  await db.insert(presetNovels).values({
    id: presetId,
    title: row.title ?? '未命名',
    author: row.author,
    genre: null,
    description: summary,
    coverEmoji: null,
    storageKey: txtKey,
    encoding: 'utf-8',
    chapterCount: 1,
    charCount,
    featured: 1,
    sortOrder: 0,
    downloadCount: 0,
    createdAt: now
  }).onConflictDoUpdate({
    target: presetNovels.id,
    set: {
      title: row.title ?? '未命名',
      author: row.author,
      description: summary,
      storageKey: txtKey,
      featured: 1
    }
  }).run()

  return { ok: true, presetId, title: row.title, mode: row.mode }
})
