// app/utils/gameSaveStore.ts
// 游戏存档点(本地 IndexedDB):每次行动完成后把整局快照(消息流+状态+章节)落盘,
// 长按/右键行动气泡可回滚到任意历史节点。仅浏览器端生效(SSR 时自动跳过)。
import type { GameState } from '../../shared/novel'
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
  currentChapter: string | null
  messages: SaveMsg[]
  savedAt: string
}

export async function saveGamePoint(point: GameSavePoint): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  // 入库存纯数据:Vue reactive proxy 结构化克隆会抛 DataCloneError
  await d.put(STORE, JSON.parse(JSON.stringify(point)))
}

/** 列出某游戏的全部存档点,按序号倒序(最新的在前) */
export async function listGamePoints(gameId: string): Promise<GameSavePoint[]> {
  if (typeof indexedDB === 'undefined') return []
  const d = await db()
  const all = await d.getAll(STORE)
  return all
    .filter(p => p.gameId === gameId)
    .sort((a, b) => b.idx - a.idx)
}

/** 删除某游戏序号 >= fromIdx 的存档点(回滚后清理失效快照) */
export async function pruneGamePoints(gameId: string, fromIdx: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const d = await db()
  const all = await d.getAll(STORE)
  for (const p of all) {
    if (p.gameId === gameId && p.idx >= fromIdx) {
      await d.delete(STORE, p.key)
    }
  }
}
