// server/api/games/import.post.ts
// 游戏云端同步(登录用户):用本地 LocalGame 快照整体 upsert(会话 + 消息流)。
// 浏览器驱动回合,本地为真源;云端用于跨设备续玩。
import { requireUserId } from '../../utils/authz'
import { getGame, createGame, deleteMessagesByGame, appendMessage } from '../../utils/game-db'
import type { LocalGame } from '../../../shared/novel'

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)
  const body = await readBody<LocalGame>(event).catch(() => null)
  if (!body?.id) {
    throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  }

  const patch = {
    novel_id: body.workId ?? null,
    user_id: userId,
    player_character_id: body.characterName ?? null,
    player_character_name: body.playerName ?? null,
    mode: 'canonical',
    current_chapter: body.currentChapter ?? null,
    status: body.status ?? 'active',
    summary: body.summary ? JSON.stringify(body.summary) : null,
    state: JSON.stringify(body.state ?? {})
  }

  const existing = await getGame(event, body.id)
  if (existing) {
    if (existing.user_id !== userId) {
      throw createError({ statusCode: 404, statusMessage: 'Game not found' })
    }
  } else {
    await createGame(event, { id: body.id, ...patch })
  }

  // 消息流整体重建(本地为真源,云端仅镜像)
  await deleteMessagesByGame(event, body.id)
  for (const m of body.messages ?? []) {
    await appendMessage(event, {
      id: m.id,
      game_id: body.id,
      idx: m.idx,
      role: m.role,
      speaker: m.speaker,
      content: m.content
    })
  }

  return { ok: true, id: body.id }
})
