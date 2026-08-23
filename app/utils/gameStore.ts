// app/utils/gameStore.ts
// 本地游戏会话库(IndexedDB games):浏览器驱动回合,本地为真源。
// 登录用户可手动同步云端(POST /api/games/import / GET /api/games 跨设备恢复)。
import type { LocalGame, GameState } from '../../shared/novel'
import { db } from './localDb'

const STORE = 'games'

type FlatMsg = LocalGame['messages'][number]

export async function listLocalGames(): Promise<LocalGame[]> {
  if (typeof indexedDB === 'undefined') return []
  const d = await db()
  return (await d.getAll(STORE)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getLocalGame(id: string): Promise<LocalGame | null> {
  if (typeof indexedDB === 'undefined') return null
  const d = await db()
  return (await d.get(STORE, id)) ?? null
}

export async function saveLocalGame(game: LocalGame): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.put(STORE, JSON.parse(JSON.stringify({ ...game, updatedAt: new Date().toISOString() })))
}

export async function deleteLocalGame(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  await d.delete(STORE, id)
}

/** 新建本地游戏会话(选角页调用) */
export async function createLocalGame(args: {
  id: string
  workId: string
  playerName: string
  characterName: string
  state: GameState
}): Promise<LocalGame> {
  const game: LocalGame = {
    id: args.id,
    workId: args.workId,
    playerName: args.playerName,
    characterName: args.characterName,
    state: args.state,
    messages: [],
    summary: null,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncStatus: 'local'
  }
  await saveLocalGame(game)
  return game
}

export function appendLocalMessage(game: LocalGame, msg: Omit<FlatMsg, 'idx'> & { idx?: number }): void {
  game.messages.push({ idx: game.messages.length, ...msg })
}

/** 同步到云端(登录用户);未登录或失败返回 false */
export async function syncGameToCloud(game: LocalGame): Promise<boolean> {
  try {
    const res = await $fetch('/api/games/import', {
      method: 'POST',
      body: JSON.parse(JSON.stringify(game))
    }).catch(() => null)
    if (!res) return false
    game.syncStatus = 'synced'
    await saveLocalGame(game)
    return true
  } catch {
    return false
  }
}
