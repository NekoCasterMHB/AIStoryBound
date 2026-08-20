// server/utils/db.ts
// 数据访问层:基于 Drizzle + Cloudflare D1(binding DB)
// 每个函数接收 H3Event,从中取 D1 binding 并初始化 drizzle(见 useD1)
import type { H3Event } from 'h3'
import { useD1 } from './d1'
import { novels, novelChapters, jobs } from '../db/schema'
import { eq } from 'drizzle-orm'
import type { NovelRow, ChapterRow, JobRow } from '../../shared/novel'

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
  return rows.map((r) => ({
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

/** 批量插入章节 */
export async function insertChapters(event: H3Event, novelId: string, chapters: { idx: number, title: string, content: string }[]) {
  const db = useD1(event)
  await db.insert(novelChapters).values(
    chapters.map((c) => ({
      id: `${novelId}-${c.idx}`,
      novelId,
      idx: c.idx,
      title: c.title ?? '',
      content: c.content,
      charCount: c.content.length
    }))
  ).run()
}

export async function countChapters(event: H3Event, novelId: string): Promise<number> {
  const db = useD1(event)
  const rows = await db.select({ n: novelChapters.id }).from(novelChapters).where(eq(novelChapters.novelId, novelId)).all()
  return rows.length
}

export async function listChapters(event: H3Event, novelId: string): Promise<ChapterRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(novelChapters).where(eq(novelChapters.novelId, novelId)).orderBy(novelChapters.idx).all()
  return rows.map((r) => ({
    id: r.id,
    novel_id: r.novelId,
    idx: r.idx ?? 0,
    title: r.title ?? '',
    content: r.content ?? '',
    char_count: r.charCount ?? 0
  }))
}

// ---- jobs ----

export async function createJob(event: H3Event, job: { id: string, type: string, payload?: string, status?: string }) {
  const db = useD1(event)
  return db.insert(jobs).values({
    id: job.id,
    type: job.type,
    payload: job.payload ?? '{}',
    status: job.status ?? 'queued'
  }).run()
}

export async function updateJob(event: H3Event, id: string, patch: Partial<Omit<JobRow, 'id'>>) {
  const db = useD1(event)
  const values: Record<string, unknown> = {}
  if ('status' in patch) values.status = patch.status
  if ('progress' in patch) values.progress = patch.progress
  if ('error' in patch) values.error = patch.error
  if ('result' in patch) values.result = patch.result
  values.updatedAt = new Date().toISOString()
  if (Object.keys(values).filter((k) => k !== 'updatedAt').length === 0) return
  return db.update(jobs).set(values).where(eq(jobs.id, id)).run()
}
