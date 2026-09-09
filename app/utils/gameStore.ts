// app/utils/gameStore.ts
// 本地游戏会话库(IndexedDB games + game-messages):浏览器驱动回合,本地为真源。
// 云端备份由按作品整包 ZIP 承担(见 backupStore.ts),本模块不再含同步逻辑。
// v14 起消息拆独立表(game-messages,append-only 一消息一行):每回合 persist 只写 games 行
// (state/summary/optionsByMessage 等有界字段)+ 新增消息行,不再整局 O(局史) 重写。
import type { LocalGame, LocalGameRow, GameState } from '#shared/novel'
import Dexie from 'dexie'
import { db, STORE_GAMES, STORE_GAME_MESSAGES, type LocalGameMessageRow } from './localDb'

const STORE = STORE_GAMES

type FlatMsg = LocalGame['messages'][number]

/** games 表行 → 完整形状(无消息;msgCount 补 messages.length 占位由调用方按需拼装) */
function rowToGame(row: LocalGameRow): LocalGame {
  return { ...row, messages: [] } as LocalGame
}

/** LocalGame → games 表行(剥离 messages;msgCount 以传入计数为准)。游戏页增量持久化用 */
export function gameToRow(game: LocalGame, msgCount: number): LocalGameRow {
  const { messages: _m, ...row } = game
  return { ...row, msgCount } as LocalGameRow
}

/** 列出全部会话(games 行直读,不含消息体;msgCount 供列表展示) */
export async function listLocalGames(): Promise<LocalGame[]> {
  if (typeof indexedDB === 'undefined') return []
  const rows = await db.table(STORE).toArray() as unknown as LocalGameRow[]
  return rows
    .map(r => ({ ...rowToGame(r), msgCount: r.msgCount ?? 0 }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 读单会话(games 行;消息请另行 listGameMessages) */
export async function getLocalGame(id: string): Promise<LocalGame | null> {
  if (typeof indexedDB === 'undefined') return null
  const row = (await db.table(STORE).get(id)) as unknown as LocalGameRow | undefined
  return row ? rowToGame(row) : null
}

/** 写会话行(消息由 appendGameMessages/syncGameMessages 负责;msgCount 显式传入) */
export async function saveLocalGameRow(row: LocalGameRow): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE).put(JSON.parse(JSON.stringify({ ...row, updatedAt: new Date().toISOString() })))
}

/** 兼容入口:完整形状保存(创建会话/测试等少量路径;大消息量请走 saveLocalGameRow + 消息 API) */
export async function saveLocalGame(game: LocalGame): Promise<void> {
  await saveLocalGameRow(gameToRow(game, game.msgCount ?? game.messages.length))
  await syncGameMessages(game.id, game.messages)
}

export async function deleteLocalGame(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await Promise.all([
    db.table(STORE).delete(id),
    db.table(STORE_GAME_MESSAGES).where('gameId').equals(id).delete()
  ])
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

/** 读某局全部消息(按 idx 升序;走 [gameId+idx] 主键范围) */
export async function listGameMessages(gameId: string): Promise<LocalGameMessageRow[]> {
  if (typeof indexedDB === 'undefined') return []
  const rows = await db.table(STORE_GAME_MESSAGES)
    .where('[gameId+idx]').between([gameId, Dexie.minKey], [gameId, Dexie.maxKey], true, true)
    .toArray()
  return rows.sort((a, b) => a.idx - b.idx)
}

/** 把内存消息同步进消息表:仅 upsert 传入集合(幂等,按 [gameId+idx] 主键覆盖),不删除多余行 */
export async function syncGameMessages(gameId: string, messages: FlatMsg[]): Promise<void> {
  if (typeof indexedDB === 'undefined' || messages.length === 0) return
  const rows: LocalGameMessageRow[] = messages.map(m => ({
    gameId, idx: m.idx, msgId: m.id, role: m.role, speaker: m.speaker, content: m.content
  }))
  await db.table(STORE_GAME_MESSAGES).bulkPut(JSON.parse(JSON.stringify(rows)))
}

/** 删除某局 idx > waterline 的消息(回滚:水位线以上全部作废) */
export async function deleteGameMessagesAfter(gameId: string, waterline: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE_GAME_MESSAGES)
    .where('[gameId+idx]').between([gameId, waterline + 1], [gameId, Dexie.maxKey], true, true)
    .delete()
}

/** 原样写回本地(备份恢复用):保留 updatedAt/syncStatus 等字段,不被 saveLocalGame 的时间戳覆盖;
 *  行内若带旧格式 messages(旧备份)自动拆进消息表。恢复语义 = 全量替换:
 *  先截断水位线以上残留(本地可能比备份玩得更远),再写入备份消息 */
export async function restoreLocalGame(game: LocalGame): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await saveLocalGameRow(gameToRow(game, game.msgCount ?? game.messages.length))
  const lastIdx = game.messages.length ? game.messages[game.messages.length - 1]!.idx : -1
  await deleteGameMessagesAfter(game.id, lastIdx)
  await syncGameMessages(game.id, game.messages)
}
