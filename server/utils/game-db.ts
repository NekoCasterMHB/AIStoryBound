// server/utils/game-db.ts
// 游戏数据访问层:基于 Drizzle + Cloudflare D1(binding DB),会话/消息/选项/存档
import type { H3Event } from 'h3'
import { useD1 } from './d1'
import { games, gameMessages, gameOptions, saves } from '../db/schema'
import { eq, and, asc, desc, gt, inArray } from 'drizzle-orm'
import type { GameRow, GameMessageRow, GameOptionRow, SaveRow, MessageRole } from '../../shared/novel'

function mapGame(r: any): GameRow {
  return {
    id: r.id,
    novel_id: r.novelId,
    user_id: r.userId,
    player_character_id: r.playerCharacterId,
    player_character_name: r.playerCharacterName,
    mode: r.mode ?? 'canonical',
    current_chapter: r.currentChapter,
    status: r.status ?? 'active',
    summary: r.summary,
    state: r.state,
    created_at: r.createdAt,
    updated_at: r.updatedAt
  }
}

function mapMessage(r: any): GameMessageRow {
  return {
    id: r.id,
    game_id: r.gameId,
    idx: r.idx ?? 0,
    role: r.role,
    speaker: r.speaker,
    content: r.content ?? '',
    created_at: r.createdAt
  }
}

function mapOption(r: any): GameOptionRow {
  return {
    id: r.id,
    game_id: r.gameId,
    message_id: r.messageId,
    idx: r.idx ?? 0,
    text: r.text ?? '',
    effects: r.effects
  }
}

function mapSave(r: any): SaveRow {
  return {
    id: r.id,
    game_id: r.gameId,
    name: r.name,
    snapshot: r.snapshot,
    created_at: r.createdAt
  }
}

// ---- 会话 ----

export async function createGame(event: H3Event, g: {
  id: string
  novel_id: string
  user_id: string
  player_character_id: string
  player_character_name: string
  mode?: string
  state?: string
}) {
  const db = useD1(event)
  return db.insert(games).values({
    id: g.id,
    novelId: g.novel_id,
    userId: g.user_id,
    playerCharacterId: g.player_character_id,
    playerCharacterName: g.player_character_name,
    mode: g.mode ?? 'canonical',
    status: 'active',
    state: g.state ?? null
  }).run()
}

export async function getGame(event: H3Event, id: string): Promise<GameRow | null> {
  const db = useD1(event)
  const rows = await db.select().from(games).where(eq(games.id, id)).all()
  return rows[0] ? mapGame(rows[0]) : null
}

export async function listGamesByUser(event: H3Event, userId: string): Promise<GameRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(games).where(eq(games.userId, userId)).all()
  return rows.map(mapGame)
}

export async function updateGame(event: H3Event, id: string, patch: Partial<Omit<GameRow, 'id'>>) {
  const db = useD1(event)
  const values: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if ('player_character_id' in patch) values.playerCharacterId = patch.player_character_id
  if ('current_chapter' in patch) values.currentChapter = patch.current_chapter
  if ('status' in patch) values.status = patch.status
  if ('summary' in patch) values.summary = patch.summary
  if ('state' in patch) values.state = patch.state
  return db.update(games).set(values).where(eq(games.id, id)).run()
}

// ---- 消息 ----

export async function appendMessage(event: H3Event, m: {
  id: string
  game_id: string
  idx: number
  role: MessageRole | string
  speaker?: string | null
  content: string
}) {
  const db = useD1(event)
  return db.insert(gameMessages).values({
    id: m.id,
    gameId: m.game_id,
    idx: m.idx,
    role: m.role,
    speaker: m.speaker ?? null,
    content: m.content
  }).run()
}

export async function countMessages(event: H3Event, gameId: string): Promise<number> {
  const db = useD1(event)
  const rows = await db.select({ id: gameMessages.id }).from(gameMessages).where(eq(gameMessages.gameId, gameId)).all()
  return rows.length
}

export async function listMessages(event: H3Event, gameId: string): Promise<GameMessageRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(gameMessages).where(eq(gameMessages.gameId, gameId)).orderBy(asc(gameMessages.idx)).all()
  return rows.map(mapMessage)
}

export async function deleteMessage(event: H3Event, messageId: string) {
  const db = useD1(event)
  return db.delete(gameMessages).where(eq(gameMessages.id, messageId)).run()
}

export async function deleteMessagesByGame(event: H3Event, gameId: string) {
  const db = useD1(event)
  return db.delete(gameMessages).where(eq(gameMessages.gameId, gameId)).run()
}

/** 回滚:删除序号 > idx 的消息,并清理这些消息挂载的选项行;返回删除的消息数 */
export async function deleteMessagesFrom(event: H3Event, gameId: string, idx: number) {
  const db = useD1(event)
  const rows = await db.select({ id: gameMessages.id }).from(gameMessages)
    .where(and(eq(gameMessages.gameId, gameId), gt(gameMessages.idx, idx))).all()
  const ids = rows.map(r => r.id)
  await db.delete(gameMessages).where(and(eq(gameMessages.gameId, gameId), gt(gameMessages.idx, idx))).run()
  if (ids.length) {
    await db.delete(gameOptions).where(and(eq(gameOptions.gameId, gameId), inArray(gameOptions.messageId, ids))).run()
  }
  return ids.length
}

// ---- 选项 ----

export async function insertOptions(event: H3Event, opts: {
  id: string
  game_id: string
  message_id: string
  text: string
  effects?: string | null
}[]) {
  const db = useD1(event)
  await db.insert(gameOptions).values(
    opts.map((o, i) => ({
      id: o.id,
      gameId: o.game_id,
      messageId: o.message_id,
      idx: i,
      text: o.text,
      effects: o.effects ?? null
    }))
  ).run()
}

export async function listOptionsByMessage(event: H3Event, messageId: string): Promise<GameOptionRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(gameOptions).where(eq(gameOptions.messageId, messageId)).orderBy(asc(gameOptions.idx)).all()
  return rows.map(mapOption)
}

// ---- 存档 ----

export async function createSave(event: H3Event, s: { id: string, game_id: string, name?: string | null, snapshot: string }) {
  const db = useD1(event)
  return db.insert(saves).values({
    id: s.id,
    gameId: s.game_id,
    name: s.name ?? null,
    snapshot: s.snapshot
  }).run()
}

export async function getSave(event: H3Event, id: string): Promise<SaveRow | null> {
  const db = useD1(event)
  const rows = await db.select().from(saves).where(eq(saves.id, id)).all()
  return rows[0] ? mapSave(rows[0]) : null
}

export async function listSaves(event: H3Event, gameId: string): Promise<SaveRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(saves).where(eq(saves.gameId, gameId)).orderBy(desc(saves.createdAt)).all()
  return rows.map(mapSave)
}

export async function deleteSave(event: H3Event, id: string) {
  const db = useD1(event)
  return db.delete(saves).where(eq(saves.id, id)).run()
}
