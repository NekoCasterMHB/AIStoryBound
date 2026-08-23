// server/utils/db.ts
// 数据访问层:基于 Drizzle + Cloudflare D1(binding DB)
// 每个函数接收 H3Event,从中取 D1 binding 并初始化 drizzle(见 useD1)
import type { H3Event } from 'h3'
import { useD1 } from './d1'
import { novels, presetNovels } from '../db/schema'
import { eq, sql } from 'drizzle-orm'
import type { NovelRow, PresetNovelRow } from '../../shared/novel'

// ---- 预置小说 ----

function toPresetRow(r: typeof presetNovels.$inferSelect): PresetNovelRow {
  return {
    id: r.id,
    title: r.title ?? '',
    author: r.author,
    genre: r.genre,
    description: r.description,
    cover_emoji: r.coverEmoji,
    storage_key: r.storageKey,
    encoding: r.encoding ?? 'utf-8',
    chapter_count: r.chapterCount ?? 0,
    char_count: r.charCount ?? 0,
    featured: r.featured ?? 1,
    sort_order: r.sortOrder ?? 0,
    download_count: r.downloadCount ?? 0,
    created_at: r.createdAt
  }
}

/** 查询单本预置小说 */
export async function getPresetNovel(event: H3Event, id: string): Promise<PresetNovelRow | null> {
  const db = useD1(event)
  const rows = await db.select().from(presetNovels).where(eq(presetNovels.id, id)).all()
  return rows[0] ? toPresetRow(rows[0]) : null
}

/** 首页推荐列表(featured=1,按 sort_order 升序) */
export async function listFeaturedPresets(event: H3Event): Promise<PresetNovelRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(presetNovels)
    .where(eq(presetNovels.featured, 1))
    .orderBy(presetNovels.sortOrder, presetNovels.createdAt)
    .all()
  return rows.map(toPresetRow)
}

/** 下载链接被访问时累加下载计数 */
export async function incrementPresetDownloads(event: H3Event, id: string) {
  const db = useD1(event)
  await db.update(presetNovels)
    .set({ downloadCount: sql`${presetNovels.downloadCount} + 1` })
    .where(eq(presetNovels.id, id)).run()
}

/** 新增小说记录 */
export async function createNovel(event: H3Event, novel: {
  id: string
  user_id: string
  title: string
  author?: string | null
  source_format?: string
  storage_key?: string | null
  encoding?: string | null
  status?: string
  parse_progress?: number
}) {
  const db = useD1(event)
  return db.insert(novels).values({
    id: novel.id,
    userId: novel.user_id,
    title: novel.title,
    author: novel.author ?? null,
    sourceFormat: novel.source_format ?? 'txt',
    storageKey: novel.storage_key ?? null,
    encoding: novel.encoding ?? null,
    status: novel.status ?? 'uploaded',
    parseProgress: novel.parse_progress ?? 0
  }).run()
}

/** 查询单本小说 */
export async function getNovel(event: H3Event, id: string): Promise<NovelRow | null> {
  const db = useD1(event)
  const rows = await db.select().from(novels).where(eq(novels.id, id)).all()
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id,
    user_id: r.userId,
    title: r.title ?? '',
    author: r.author,
    source_format: r.sourceFormat ?? 'txt',
    storage_key: r.storageKey,
    encoding: r.encoding,
    chapter_count: r.chapterCount ?? 0,
    status: (r.status ?? 'uploaded') as NovelRow['status'],
    parse_progress: r.parseProgress ?? 0,
    world_state: r.worldState,
    error: r.error,
    created_at: r.createdAt
  }
}

/** 查询某用户的小说列表 */
export async function listNovelsByUser(event: H3Event, userId: string): Promise<NovelRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(novels).where(eq(novels.userId, userId)).orderBy(novels.createdAt).all()
  return rows.map(r => ({
    id: r.id,
    user_id: r.userId,
    title: r.title ?? '',
    author: r.author,
    source_format: r.sourceFormat ?? 'txt',
    storage_key: r.storageKey,
    encoding: r.encoding,
    chapter_count: r.chapterCount ?? 0,
    status: (r.status ?? 'uploaded') as NovelRow['status'],
    parse_progress: r.parseProgress ?? 0,
    world_state: r.worldState,
    error: r.error,
    created_at: r.createdAt
  }))
}

/** 更新小说字段 */
export async function updateNovel(event: H3Event, id: string, patch: Partial<Omit<NovelRow, 'id'>>) {
  const db = useD1(event)
  const values: Record<string, unknown> = {}
  if ('title' in patch) values.title = patch.title
  if ('author' in patch) values.author = patch.author
  if ('encoding' in patch) values.encoding = patch.encoding
  if ('chapter_count' in patch) values.chapterCount = patch.chapter_count
  if ('status' in patch) values.status = patch.status
  if ('parse_progress' in patch) values.parseProgress = patch.parse_progress
  if ('world_state' in patch) values.worldState = patch.world_state
  if ('error' in patch) values.error = patch.error
  if (Object.keys(values).length === 0) return
  return db.update(novels).set(values).where(eq(novels.id, id)).run()
}
