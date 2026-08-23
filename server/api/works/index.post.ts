// server/api/works/index.post.ts
// 作品云端同步(登录用户):upsert novels 行。作品 = 生成结果(人物卡/概要/实体库/冲突/告警),
// 不含章节正文(正文仅存本地 IndexedDB)。
import { requireUserId } from '../../utils/authz'
import { getNovel, createNovel, updateNovel } from '../../utils/db'
import type { LocalWork } from '../../../shared/novel'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const body = await readBody<LocalWork>(event).catch(() => null)
  if (!body?.id || !body.title) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id / title' })
  }

  const worldState = JSON.stringify({
    title: body.overlay?.title ?? body.title,
    genre: body.overlay?.genre ?? null,
    summary: body.overlay?.summary ?? null,
    characters: body.overlay?.characters ?? [],
    entities: body.entities ?? null,
    conflicts: body.conflicts ?? [],
    warnings: body.warnings ?? []
  })

  const existing = await getNovel(event, body.id)
  if (existing) {
    await updateNovel(event, body.id, {
      title: body.title,
      author: body.author ?? null,
      chapter_count: body.chapters?.length ?? 0,
      status: 'ready',
      world_state: worldState
    })
  } else {
    await createNovel(event, {
      id: body.id,
      user_id: userId,
      title: body.title,
      author: body.author ?? null,
      status: 'ready'
    })
    await updateNovel(event, body.id, {
      chapter_count: body.chapters?.length ?? 0,
      world_state: worldState
    })
  }
  return { ok: true, id: body.id }
})
