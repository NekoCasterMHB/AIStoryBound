// app/utils/gameStore.ts
// 本地游戏会话库(IndexedDB games):浏览器驱动回合,本地为真源。
// 登录用户可手动同步云端(POST /api/games/import / GET /api/games 跨设备恢复)。
// 同步采用 gzip 压缩 + 增量上传:只传上次同步后的新消息/选项;回滚导致消息变短时自动降级全量重建。
import { gzipSync, strToU8 } from 'fflate'
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
  /** 初始章节(从小说章节开始时预填顶栏) */
  currentChapter?: string | null
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
    currentChapter: args.currentChapter ?? null,
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

/** 同步到云端(登录用户):gzip 压缩 + 增量上传;未登录或失败返回 false */
export async function syncGameToCloud(game: LocalGame): Promise<boolean> {
  try {
    const lastIdx = game.messages.at(-1)?.idx ?? -1
    // 增量条件:上次同步点存在且本地消息连贯未被回滚(长度与序号匹配);
    // 回滚/新局/旧存档自动走全量重建(fromIdx=-1),保证云端镜像与本地一致
    const incremental = game.lastSyncedIdx != null
      && game.lastSyncedIdx >= 0
      && lastIdx >= game.lastSyncedIdx
      && game.messages.length >= game.lastSyncedIdx + 1
    const fromIdx: number = incremental ? (game.lastSyncedIdx ?? -1) : -1
    const deltaMessages = incremental ? game.messages.filter(m => m.idx > fromIdx) : game.messages
    const deltaOptions: Record<string, { idx: number, text: string }[]> = {}
    if (incremental) {
      const newIds = new Set(deltaMessages.map(m => m.id))
      for (const [k, v] of Object.entries(game.optionsByMessage ?? {})) {
        if (newIds.has(k)) deltaOptions[k] = v
      }
    } else {
      Object.assign(deltaOptions, game.optionsByMessage ?? {})
    }

    const payload = {
      id: game.id,
      workId: game.workId,
      playerName: game.playerName,
      characterName: game.characterName,
      state: game.state,
      summary: game.summary,
      currentChapter: game.currentChapter,
      status: game.status,
      fromIdx,
      messages: deltaMessages,
      optionsByMessage: deltaOptions
    }
    const gz = gzipSync(strToU8(JSON.stringify(payload)))
    const res = await $fetch('/api/games/import', {
      method: 'POST',
      body: gz,
      headers: { 'Content-Type': 'application/gzip' }
    }).catch(() => null)
    if (!res) return false
    game.lastSyncedIdx = lastIdx
    game.syncStatus = 'synced'
    await saveLocalGame(game)
    return true
  } catch {
    return false
  }
}
