// app/utils/gameSaveStore.ts
// 游戏存档点(本地 IndexedDB):每次行动完成后落盘回滚锚点(状态+摘要+消息水位线),
// 长按/右键行动气泡可回滚到任意历史节点。仅浏览器端生效(SSR 时自动跳过)。
// v14:存档点不再复制整局消息——消息本体在 game-messages 表 append-only,回滚按 idx
// 截断该表即可;存档点行从「整局消息快照」缩为小行(此前 50 个存档点 = 50 份消息拷贝)。
import type { GameState, LocalGame } from '#shared/novel'
import { db } from './localDb'

const STORE = 'saves'

/** 一个存档点:idx=消息水位线(回滚 = 恢复 state + 截断 idx 以上的消息行) */
export interface GameSavePoint {
  key: string
  gameId: string
  idx: number
  state: GameState
  /** 剧情当前推进到的细纲段下标(0-based;旧存档点为已废弃的 currentChapter 字符串) */
  currentBeat: number | null
  /** 存盘点时刻的整局剧情摘要(回滚时随点恢复;旧存档点无此字段,读回 undefined → 按无摘要处理) */
  summary?: LocalGame['summary'] | null
  savedAt: string
}

export async function saveGamePoint(point: GameSavePoint): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  // 入库存纯数据:Vue reactive proxy 结构化克隆会抛 DataCloneError
  await db.table(STORE).put(JSON.parse(JSON.stringify(point)))
}

/** 列出某游戏的全部存档点,按序号倒序(最新的在前);走 gameId 索引(v12),不全表扫描 */
export async function listGamePoints(gameId: string): Promise<GameSavePoint[]> {
  if (typeof indexedDB === 'undefined') return []
  const mine = await db.table(STORE).where('gameId').equals(gameId).toArray() as GameSavePoint[]
  return mine.sort((a, b) => b.idx - a.idx)
}

/** 删除某游戏序号 >= fromIdx 的存档点(回滚后清理失效快照);走 gameId 索引。
 *  只取主键不反序列化快照体(每份含整局 messages):主键即 `${gameId}:${idx}`,idx 可从键解析 */
export async function pruneGamePoints(gameId: string, fromIdx: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const prefix = `${gameId}:`
  const keys = (await db.table(STORE).where('gameId').equals(gameId).keys()) as string[]
  for (const k of keys) {
    const idx = Number(k.slice(prefix.length))
    if (idx >= fromIdx) await db.table(STORE).delete(k)
  }
}

/** 删除某游戏会话的全部存档点(删除会话时清理,避免 IndexedDB 残留);走 gameId 索引 */
export async function deleteGamePoints(gameId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.table(STORE).where('gameId').equals(gameId).delete()
}

/** 每局存档点数量上限(仅保留最近 N 个,防长局无限膨胀 IndexedDB) */
export const MAX_SAVE_POINTS = 50

/** 截断某游戏的存档点:只保留序号最新的 MAX_SAVE_POINTS 个;走 gameId 索引。
 *  只取主键不反序列化快照体(每回合调用,每份快照含整局 messages,全量读回是 O(N×历史) 放大) */
export async function capGamePoints(gameId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const prefix = `${gameId}:`
  const keys = (await db.table(STORE).where('gameId').equals(gameId).keys()) as string[]
  if (keys.length <= MAX_SAVE_POINTS) return
  const sorted = keys
    .map(k => ({ k, idx: Number(k.slice(prefix.length)) }))
    .sort((a, b) => b.idx - a.idx)
  for (const p of sorted.slice(MAX_SAVE_POINTS)) {
    await db.table(STORE).delete(p.k)
  }
}

/** 按键查存档点是否存在(开局去重:同 key 已有快照则不重复写) */
export async function hasGamePoint(key: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  return (await db.table(STORE).get(key)) != null
}
