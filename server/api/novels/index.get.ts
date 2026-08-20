// server/api/novels/index.get.ts
// 查询当前用户的小说列表
import { listNovelsByUser, countChapters } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const userId = 'anon' // TODO 认证后替换
  const novels = await listNovelsByUser(event, userId)
  return Promise.all(novels.map(async (n) => ({
    ...n,
    chapter_count: await countChapters(event, n.id)
  })))
})
