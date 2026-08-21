// server/api/games/index.post.ts
// 创建游戏会话:校验小说已解析 + 玩家所选角色存在 → 建 games 行(含初始游戏状态) → 返回会话
import { getNovel } from '../../utils/db'
import { createGame } from '../../utils/game-db'
import { uuid } from '../../../shared/novel'
import type { WorldOverlay, GameState } from '../../../shared/novel'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ novelId?: string, characterName?: string, mode?: string }>(event)
  const novelId = body.novelId
  const characterName = (body.characterName || '').trim()
  if (!novelId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing novelId' })
  }
  if (!characterName) {
    throw createError({ statusCode: 400, statusMessage: 'Missing characterName' })
  }

  const novel = await getNovel(event, novelId)
  if (!novel) {
    throw createError({ statusCode: 404, statusMessage: 'Novel not found' })
  }
  if (novel.status !== 'ready') {
    throw createError({ statusCode: 400, statusMessage: 'Novel 尚未解析完成' })
  }

  // 从 world_state 取出人物卡,校验玩家所选角色
  let world: WorldOverlay | null = null
  try {
    world = novel.world_state ? JSON.parse(novel.world_state) as WorldOverlay : null
  } catch {
    world = null
  }
  if (!world) {
    throw createError({ statusCode: 400, statusMessage: '小说缺少世界观数据(world_state)' })
  }
  const characters = world.characters ?? []
  const player = characters.find((c) => c.name === characterName)
  if (!player) {
    throw createError({ statusCode: 400, statusMessage: `角色 "${characterName}" 不在该小说人物卡中` })
  }

  const userId = 'anon' // TODO(用户系统 §4.1):接入认证后改为真实 userId
  const gameId = uuid()

  // 初始状态:关系网按人物卡播种为中立(0),HP/金钱给默认值
  const relationships: Record<string, number> = {}
  for (const c of characters) {
    if (c.name !== characterName) relationships[c.name] = 0
  }
  const state: GameState = {
    location: '',
    time: '',
    hp: 100,
    money: 100,
    relationships,
    quests: [],
    flags: {}
  }

  await createGame(event, {
    id: gameId,
    novel_id: novelId,
    user_id: userId,
    player_character_id: characterName,
    player_character_name: characterName,
    mode: 'canonical',
    state: JSON.stringify(state)
  })

  return {
    id: gameId,
    novel_id: novelId,
    player_character_id: characterName,
    player_character_name: characterName,
    mode: 'canonical',
    status: 'active',
    state,
    world: {
      title: world.title ?? novel.title,
      genre: world.genre,
      summary: world.summary
    }
  }
})
