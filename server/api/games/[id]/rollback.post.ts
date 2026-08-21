// server/api/games/[id]/rollback.post.ts
// 回滚:客户端完成本地回退后同步服务端 —— 删除序号 > idx 的消息与选项,
// 恢复该时刻的状态/章节,并清空滚动摘要(旧摘要可能覆盖了回滚点之后的事件)。
import { getGame, deleteMessagesFrom, updateGame, countMessages } from '../../../utils/game-db'
import type { GameState } from '../../../../shared/novel'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  }

  const body = await readBody<{ idx?: number, state?: GameState, current_chapter?: string | null }>(event).catch(() => ({}))
  const idx = body.idx
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < -1) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid idx' })
  }

  const game = await getGame(event, id)
  if (!game) {
    throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  }

  await deleteMessagesFrom(event, id, idx)
  await updateGame(event, id, {
    state: JSON.stringify(body.state ?? {}),
    current_chapter: body.current_chapter ?? null,
    summary: null
  })

  return { ok: true, message_count: await countMessages(event, id) }
})
