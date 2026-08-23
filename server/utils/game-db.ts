// server/utils/game-db.ts
// 游戏数据访问层(D1 作为云端同步存储):会话/消息。浏览器本地为真源,云端仅镜像
import type { H3Event } from 'h3'
import { useD1 } from './d1'
import { games, gameMessages, gameOptions } from '../db/schema'
import { eq, asc } from 'drizzle-orm'
import type { GameRow, GameMessageRow, GameOptionRow, MessageRole } from '../../shared/novel'

function mapGame(r: typeof games.$inferSelect): GameRow {
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

function mapMessage(r: typeof gameMessages.$inferSelect): GameMessageRow {
  return {
    id: r.id,
    game_id: r.gameId,
    idx: r.idx ?? 0,
    role: r.role ?? 'narrator',
    speaker: r.speaker,
    content: r.content ?? '',
    created_at: r.createdAt
  }
}

function mapOption(r: typeof gameOptions.$inferSelect): GameOptionRow {
  return {
    id: r.id,
    game_id: r.gameId,
    message_id: r.messageId,
    idx: r.idx ?? 0,
    text: r.text ?? '',
    effects: r.effects
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

export async function listMessages(event: H3Event, gameId: string): Promise<GameMessageRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(gameMessages).where(eq(gameMessages.gameId, gameId)).orderBy(asc(gameMessages.idx)).all()
  return rows.map(mapMessage)
}

export async function deleteMessagesByGame(event: H3Event, gameId: string) {
  const db = useD1(event)
  return db.delete(gameMessages).where(eq(gameMessages.gameId, gameId)).run()
}

// ---- 选项(云端恢复时还原某条消息挂载的选项) ----

export async function listOptionsByMessage(event: H3Event, messageId: string): Promise<GameOptionRow[]> {
  const db = useD1(event)
  const rows = await db.select().from(gameOptions).where(eq(gameOptions.messageId, messageId)).orderBy(asc(gameOptions.idx)).all()
  return rows.map(mapOption)
}
