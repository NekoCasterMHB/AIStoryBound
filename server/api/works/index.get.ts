// server/api/works/index.get.ts
// 云端作品列表(登录用户;换设备恢复用,条目不含实体库)
import { requireUserId } from '../../utils/authz'
import { listNovelsByUser } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const novels = await listNovelsByUser(event, userId)
  return novels.map(n => ({
    id: n.id,
    title: n.title,
    chapter_count: n.chapter_count,
    status: n.status,
    created_at: n.created_at
  }))
})
