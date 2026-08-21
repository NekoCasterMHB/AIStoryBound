// server/api/games/[id].get.ts
// 查询游戏会话详情:会话 + 已解析的 state + 消息流 + 所属小说的世界观(供游戏页/选角页渲染)
import { getNovel } from '../../utils/db'
import { getGame, listMessages, listOptionsByMessage } from '../../utils/game-db'
import type { WorldOverlay, GameState } from '../../../shared/novel'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const game = await getGame(event, id)
  if (!game) {
    throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  }

  let world: WorldOverlay | null = null
  if (game.novel_id) {
    const novel = await getNovel(event, game.novel_id)
    if (novel?.world_state) {
      try {
        world = JSON.parse(novel.world_state) as WorldOverlay
      } catch {
        world = null
      }
    }
  }

  // 消息流 + 每条消息对应的选项
  const messages = await listMessages(event, id)
  const optionsByMessage: Record<string, { idx: number, text: string }[]> = {}
  for (const m of messages) {
    optionsByMessage[m.id] = (await listOptionsByMessage(event, m.id)).map((o) => ({ idx: o.idx, text: o.text }))
  }

  let state: GameState | null = null
  if (game.state) {
    try {
      state = JSON.parse(game.state) as GameState
    } catch {
      state = null
    }
  }

  return {
    id: game.id,
    novel_id: game.novel_id,
    player_character_id: game.player_character_id,
    player_character_name: game.player_character_name,
    mode: game.mode,
    current_chapter: game.current_chapter,
    status: game.status,
    summary: game.summary,
    state,
    world,
    messages,
    optionsByMessage
  }
})
