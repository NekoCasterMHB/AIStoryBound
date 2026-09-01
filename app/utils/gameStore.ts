// app/utils/gameStore.ts
// 本地游戏会话库(IndexedDB games):浏览器驱动回合,本地为真源。
// 云端备份由按作品整包 ZIP 承担(见 backupStore.ts),本模块不再含同步逻辑。
import type { LocalGame, GameState } from '#shared/novel'
import { db } from './localDb'

const STORE = 'games'

type FlatMsg = LocalGame['messages'][number]

export async function listLocalGames(): Promise<LocalGame[]> {
  if (typeof indexedDB === 'undefined') return []
  return (await db.table(STORE).toArray()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getLocalGame(id: string): Promise<LocalGame | null> {
  if (typeof indexedDB === 'undefined') return null
  return (await db.table(STORE).get(id)) ?? null
}

export async function saveLocalGame(game: LocalGame): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE).put(JSON.parse(JSON.stringify({ ...game, updatedAt: new Date().toISOString() })))
}

export async function deleteLocalGame(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE).delete(id)
}

/** 新建本地游戏会话(选角页调用) */
export async function createLocalGame(args: {
  id: string
  workId: string
  playerName: string
  characterName: string
  state: GameState
  /** 开局设定(仅首回合生效) */
  opening?: LocalGame['opening']
  /** 剧情起始细纲段下标(0-based) */
  currentBeat?: number | null
}): Promise<LocalGame> {
  const game: LocalGame = {
    id: args.id,
    workId: args.workId,
    playerName: args.playerName,
    characterName: args.characterName,
    state: args.state,
    messages: [],
    summary: null,
    opening: args.opening,
    currentBeat: args.currentBeat ?? null,
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

/** 原样写回本地(备份恢复用):保留 updatedAt/syncStatus 等字段,不被 saveLocalGame 的时间戳覆盖 */
export async function restoreLocalGame(game: LocalGame): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE).put(JSON.parse(JSON.stringify(game)))
}
