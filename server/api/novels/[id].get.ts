// server/api/novels/[id].get.ts
// 查询单本小说状态(前端轮询用)
import { getNovel, countChapters } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const novel = await getNovel(event, id)
  if (!novel) {
    throw createError({ statusCode: 404, statusMessage: 'Novel not found' })
  }
  return {
    ...novel,
    chapter_count: await countChapters(event, id)
  }
})
