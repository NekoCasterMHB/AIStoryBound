// server/api/games/index.get.ts
// 云端游戏列表(登录用户;跨设备恢复入口)
import { requireUserId } from '../../utils/authz'
import { listGamesByUser } from '../../utils/game-db'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const rows = await listGamesByUser(event, userId)
  return rows.map(g => ({
    id: g.id,
    novel_id: g.novel_id,
    player_character_name: g.player_character_name,
    current_chapter: g.current_chapter,
    status: g.status,
    updated_at: g.updated_at
  }))
})
