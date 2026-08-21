// server/api/games/[id]/saves/index.get.ts
// 列出某会话的全部存档(按创建时间倒序)
import { listSaves } from '../../../../utils/game-db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const saves = await listSaves(event, id)
  return saves.map((s) => ({
    id: s.id,
    name: s.name,
    created_at: s.created_at
  }))
})