// server/api/games/[id].get.ts
// 查询游戏会话详情:会话 + 已解析的 state + 消息流 + 所属小说的世界观(供游戏页/选角页渲染)
import { getNovel } from '../../utils/db'
import { getGame, listMessages, listOptionsByMessage } from '../../utils/game-db'
import { assertGameOwned } from '../../utils/authz'
import type { WorldOverlay, GameState, StoryBeat, WorldEntities, EntityConflict } from '../../../shared/novel'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  const game = await getGame(event, id)
  if (!game) {
    throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  }
  const userId = await assertGameOwned(event, game)

  let world: WorldOverlay | null = null
  let entities: WorldEntities | null = null
  let conflicts: EntityConflict[] = []
  let storyline: StoryBeat[] = []
  if (game.novel_id) {
    const novel = await getNovel(event, game.novel_id)
    // 双保险:即使 game 挂载了他人作品,也不返回其世界观
    if (novel?.user_id === userId && novel.world_state) {
      try {
        const raw = JSON.parse(novel.world_state) as Record<string, unknown>
        world = {
          title: typeof raw.title === 'string' ? raw.title : novel.title,
          genre: typeof raw.genre === 'string' ? raw.genre : undefined,
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          characters: Array.isArray(raw.characters) ? raw.characters as WorldOverlay['characters'] : [],
          tags: Array.isArray(raw.tags) ? raw.tags as string[] : undefined,
          orientation: typeof raw.orientation === 'string' ? raw.orientation : undefined,
          setting: typeof raw.setting === 'string' ? raw.setting : undefined,
          heat: raw.heat === '淡' || raw.heat === '中' || raw.heat === '烈' ? raw.heat : undefined,
          contentWarnings: Array.isArray(raw.contentWarnings) ? raw.contentWarnings as string[] : undefined,
          tropes: Array.isArray(raw.tropes) ? raw.tropes as string[] : undefined,
          kinkProfile: Array.isArray(raw.kinkProfile) ? raw.kinkProfile as WorldOverlay['kinkProfile'] : undefined
        }
        entities = (raw.entities && typeof raw.entities === 'object') ? raw.entities as WorldEntities : null
        conflicts = Array.isArray(raw.conflicts) ? raw.conflicts as EntityConflict[] : []
        storyline = Array.isArray(raw.storyline) ? raw.storyline as StoryBeat[] : []
      } catch {
        world = null
      }
    }
  }

  // 消息流 + 每条消息对应的选项
  const messages = await listMessages(event, id)
  const optionsByMessage: Record<string, { idx: number, text: string }[]> = {}
  for (const m of messages) {
    optionsByMessage[m.id] = (await listOptionsByMessage(event, m.id)).map(o => ({ idx: o.idx, text: o.text }))
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
    entities,
    conflicts,
    storyline,
    messages,
    optionsByMessage
  }
})
