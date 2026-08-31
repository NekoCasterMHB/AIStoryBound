// app/utils/gameSaveStore.ts
// 游戏存档点(本地 IndexedDB):每次行动完成后把整局快照(消息流+状态+章节)落盘,
// 长按/右键行动气泡可回滚到任意历史节点。仅浏览器端生效(SSR 时自动跳过)。
import type { GameState } from '#shared/novel'
import { db } from './localDb'

const STORE = 'saves'

/** 与游戏页消息结构一致(纯数据,可直接结构化克隆) */
export interface SaveMsg {
  id: string
  idx: number
  role: string
  speaker: string | null
  content: string
}

/** 一个存档点:idx=快照最后一条消息的序号(回滚时以 idx < 行动序号 定位) */
export interface GameSavePoint {
  key: string
  gameId: string
  idx: number
  state: GameState
  /** 剧情当前推进到的细纲段下标(0-based;旧存档点为已废弃的 currentChapter 字符串) */
  currentBeat: number | null
  messages: SaveMsg[]
  savedAt: string
}

export async function saveGamePoint(point: GameSavePoint): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  // 入库存纯数据:Vue reactive proxy 结构化克隆会抛 DataCloneError
  await db.table(STORE).put(JSON.parse(JSON.stringify(point)))
}

/** 列出某游戏的全部存档点,按序号倒序(最新的在前) */
export async function listGamePoints(gameId: string): Promise<GameSavePoint[]> {
  if (typeof indexedDB === 'undefined') return []
  const all = await db.table(STORE).toArray()
  return all
    .filter(p => p.gameId === gameId)
    .sort((a, b) => b.idx - a.idx)
}

/** 删除某游戏序号 >= fromIdx 的存档点(回滚后清理失效快照) */
export async function pruneGamePoints(gameId: string, fromIdx: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const all = await db.table(STORE).toArray()
  for (const p of all) {
    if (p.gameId === gameId && p.idx >= fromIdx) {
      await db.table(STORE).delete(p.key)
    }
  }
}

/** 删除某游戏会话的全部存档点(删除会话时清理,避免 IndexedDB 残留) */
export async function deleteGamePoints(gameId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const all = await db.table(STORE).toArray()
  for (const p of all) {
    if (p.gameId === gameId) await db.table(STORE).delete(p.key)
  }
}

/** 每局存档点数量上限(仅保留最近 N 个,防长局无限膨胀 IndexedDB) */
export const MAX_SAVE_POINTS = 50

/** 截断某游戏的存档点:只保留序号最新的 MAX_SAVE_POINTS 个 */
export async function capGamePoints(gameId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const all = await db.table(STORE).toArray()
  const mine = all.filter(p => p.gameId === gameId).sort((a, b) => b.idx - a.idx)
  if (mine.length <= MAX_SAVE_POINTS) return
  for (const p of mine.slice(MAX_SAVE_POINTS)) {
    await db.table(STORE).delete(p.key)
  }
}
