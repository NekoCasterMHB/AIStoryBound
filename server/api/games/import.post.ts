// server/api/games/import.post.ts
// 游戏云端同步(登录用户):gzip 压缩的 LocalGame 快照,增量/全量 upsert(会话 + 消息流 + 选项)。
// 浏览器驱动回合,本地为真源;云端用于跨设备续玩。
// 协议:fromIdx=-1 全量重建;fromIdx>=0 增量(仅重建该序号之后的消息与选项,兼容回滚截断)。
import { gunzipSync, strFromU8 } from 'fflate'
import { requireUserId } from '../../utils/authz'
import { getNovel } from '../../utils/db'
import {
  getGame,
  createGame,
  listMessages,
  deleteMessagesByGame,
  deleteMessagesAfter,
  deleteOptionsByGame,
  deleteOptionsByMessages,
  appendMessage,
  appendOption
} from '../../utils/game-db'
import type { LocalGame } from '../../../shared/novel'

/** 同步请求体:LocalGame 快照 + 同步协议字段(fromIdx/选项) */
interface SyncBody extends LocalGame {
  /** -1=全量重建;>=0=增量(云端截断该序号之后,再插入本次上传的消息/选项) */
  fromIdx?: number
  /** 进度段标签字符串(如「第3段」;存 D1 current_chapter 列,仅展示用) */
  currentChapter?: string | null
}

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event)

  // 请求体为 gzip 二进制(encoding=false 返回 Buffer);兼容未压缩的旧请求
  const raw = await readRawBody(event, false).catch(() => null)
  if (!raw) throw createError({ statusCode: 400, statusMessage: '缺少请求体' })
  const bytes = typeof raw === 'string'
    ? new TextEncoder().encode(raw)
    : raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  let body: SyncBody
  try {
    body = JSON.parse(strFromU8(gunzipSync(bytes)))
  } catch {
    try {
      body = JSON.parse(strFromU8(bytes))
    } catch {
      throw createError({ statusCode: 400, statusMessage: '请求体无法解析(需 gzip JSON)' })
    }
  }

  const id = body?.id
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 id' })

  const fromIdx = typeof body.fromIdx === 'number' ? body.fromIdx : -1
  const messages = body.messages ?? []
  const optionsByMessage: Record<string, { idx: number, text: string }[]> = body.optionsByMessage ?? {}

  // 归属校验:workId 指向的作品必须属于当前用户,防止借 game 挂载他人作品读其世界观
  if (body.workId) {
    const work = await getNovel(event, body.workId)
    if (work && work.user_id !== userId) {
      throw createError({ statusCode: 404, statusMessage: 'Game not found' })
    }
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

  const existing = await getGame(event, id)
  if (existing) {
    if (existing.user_id !== userId) {
      throw createError({ statusCode: 404, statusMessage: 'Game not found' })
    }
  } else {
    await createGame(event, { id, ...patch })
  }

  // 消息与选项重建:全量 = 清空重建;增量 = 云端截断 fromIdx 之后(含回滚产生的多余消息)再插入
  if (fromIdx < 0) {
    await deleteMessagesByGame(event, id)
    await deleteOptionsByGame(event, id)
  } else {
    const stale = (await listMessages(event, id)).filter(m => m.idx > fromIdx)
    if (stale.length) {
      await deleteOptionsByMessages(event, stale.map(m => m.id))
      await deleteMessagesAfter(event, id, fromIdx)
    }
  }
  for (const m of messages) {
    await appendMessage(event, {
      id: m.id,
      game_id: id,
      idx: m.idx,
      role: m.role,
      speaker: m.speaker,
      content: m.content
    })
  }
  for (const [msgId, opts] of Object.entries(optionsByMessage)) {
    for (const o of opts ?? []) {
      await appendOption(event, {
        id: `${msgId}#${o.idx}`,
        game_id: id,
        message_id: msgId,
        idx: o.idx,
        text: o.text
      })
    }
  }

  return { ok: true, id }
})
