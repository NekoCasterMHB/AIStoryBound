// server/api/games/[id]/saves/index.post.ts
// 创建存档:把当前会话状态(游戏状态/章节/摘要/完整消息流)快照进 saves 表
import { getGame, createSave, listMessages, listSaves } from '../../../../utils/game-db'
import { uuid } from '../../../../../shared/novel'
import type { GameState, SaveSnapshot } from '../../../../../shared/novel'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const body = await readBody<{ name?: string }>(event).catch(() => ({ name: undefined }))

  const game = await getGame(event, id)
  if (!game) {
    throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  }

  let state: GameState = { hp: 100, money: 100 }
  if (game.state) {
    try {
      state = JSON.parse(game.state) as GameState
    } catch {
      state = { hp: 100, money: 100 }
    }
  }

  const messages = await listMessages(event, id)
  const snapshot: SaveSnapshot = {
    state,
    current_chapter: game.current_chapter,
    summary: game.summary,
    messages: messages.map((m) => ({ id: m.id, idx: m.idx, role: m.role, speaker: m.speaker, content: m.content }))
  }

  const name = body.name?.trim()
    || `存档 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

  await createSave(event, {
    id: uuid(),
    game_id: id,
    name,
    snapshot: JSON.stringify(snapshot)
  })

  const saves = await listSaves(event, id)
  const created = saves[0]
  return {
    id: created?.id,
    name: created?.name,
    created_at: created?.created_at,
    message_count: messages.length
  }
})