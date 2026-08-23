// server/api/works/[id].get.ts
// 下载云端作品全文(换设备恢复:overlay + 实体库 + 冲突 + 告警;不包含章节正文)
import { requireUserId } from '../../utils/authz'
import { getNovel } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const novel = await getNovel(event, id)
  if (!novel || novel.user_id !== userId) {
    throw createError({ statusCode: 404, statusMessage: 'Work not found' })
  }
  let world: Record<string, unknown> | null = null
  if (novel.world_state) {
    try {
      world = JSON.parse(novel.world_state) as Record<string, unknown>
    } catch {
      world = null
    }
  }
  return {
    id: novel.id,
    title: novel.title,
    author: novel.author,
    chapter_count: novel.chapter_count,
    created_at: novel.created_at,
    overlay: world
      ? {
          title: world.title ?? novel.title,
          genre: world.genre ?? null,
          summary: world.summary ?? null,
          characters: world.characters ?? []
        }
      : null,
    entities: world?.entities ?? null,
    conflicts: world?.conflicts ?? [],
    warnings: world?.warnings ?? []
  }
})
