// server/api/games/[id]/saves/[saveId].post.ts
// 读档:用存档快照整体恢复会话(状态/章节/摘要 + 完整消息流重建)
import { getSave, deleteMessagesByGame, appendMessage, updateGame } from '../../../../utils/game-db'
import type { SaveSnapshot } from '../../../../../shared/novel'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const saveId = getRouterParam(event, 'saveId')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }
  if (!saveId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing saveId' })
  }

  const save = await getSave(event, saveId)
  if (!save) {
    throw createError({ statusCode: 404, statusMessage: 'Save not found' })
  }

  let snapshot: SaveSnapshot
  try {
    snapshot = JSON.parse(save.snapshot ?? '') as SaveSnapshot
  } catch {
    throw createError({ statusCode: 500, statusMessage: '存档数据损坏' })
  }

  // 重建消息流(先清空会话消息,再按快照还原)
  await deleteMessagesByGame(event, id)
  for (const m of snapshot.messages ?? []) {
    await appendMessage(event, {
      id: m.id,
      game_id: id,
      idx: m.idx,
      role: m.role,
      speaker: m.speaker,
      content: m.content
    })
  }

  await updateGame(event, id, {
    state: JSON.stringify(snapshot.state ?? {}),
    current_chapter: snapshot.current_chapter ?? null,
    summary: snapshot.summary ?? null
  })

  return {
    ok: true,
    message_count: snapshot.messages?.length ?? 0,
    current_chapter: snapshot.current_chapter
  }
})