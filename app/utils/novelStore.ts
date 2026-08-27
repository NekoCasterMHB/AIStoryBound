// app/utils/novelStore.ts
// 购买小说的本地安装:下载 TXT → 本地解析(编码检测/章节切分)→ 落本地书架(IndexedDB works),
// 并记录 商城商品id→workId 映射,供创意工坊「书架」展示"已加入书架"状态与跳转阅读/生成世界。
import { getWork, parseLocalNovel, saveWork } from './worldGen'
import type { LocalWork } from '#shared/novel'

const MAP_KEY = 'novel-installed-v1'

export interface InstalledNovel {
  workId: string
  /** 安装时的小说名(商城展示名) */
  title: string
  /** 安装的版本号 */
  version: number
  installedAt: number
}

export function getInstalledNovels(): Record<string, InstalledNovel> {
  try {
    return JSON.parse(localStorage.getItem(MAP_KEY) ?? '{}') as Record<string, InstalledNovel>
  } catch {
    return {}
  }
}

export function getInstalledNovel(id: string): InstalledNovel | null {
  return getInstalledNovels()[id] ?? null
}

/** 校验本地 work 是否仍存在(用户可能在书架删除),返回 null 表示映射失效需重新安装 */
export async function getInstalledWork(id: string): Promise<{ workId: string, work: LocalWork } | null> {
  const rec = getInstalledNovel(id)
  if (!rec) return null
  const work = await getWork(rec.workId)
  return work ? { workId: rec.workId, work } : null
}

/**
 * 安装购买的小说到本地书架:拉取指定版本 TXT → parseLocalNovel(编码检测/章节切分)→ saveWork,
 * 记录 商品id→workId 映射(安装新版本时覆盖旧映射)。返回 workId。
 * @param version 指定版本号;缺省 = 接口默认版本(购买锁定版)
 */
export async function installStoreNovel(opts: { id: string, title: string, author?: string | null, version?: number }): Promise<string> {
  const { id, title, author } = opts
  const version = opts.version
  const blob = await $fetch<Blob>(
    `/api/store/novels/${id}/download${typeof version === 'number' ? `?version=${version}` : ''}`,
    { responseType: 'blob' }
  )
  // 以商城展示名作为文件名:解析结果标题取自文件名,与商城名称保持一致
  const cleanName = title.replace(/[\\/:*?"<>|\r\n]/g, '_') || 'novel'
  const file = new File([blob], `${cleanName}.txt`, { type: 'text/plain' })
  const parsed = await parseLocalNovel(file)
  const now = new Date().toISOString()
  const work: LocalWork = {
    id: crypto.randomUUID(),
    title,
    author: author ?? undefined,
    createdAt: now,
    updatedAt: now,
    chapters: parsed.chapters,
    encoding: parsed.encoding,
    syncStatus: 'local',
    tokensUsed: 0
  }
  await saveWork(work)
  const map = getInstalledNovels()
  map[id] = { workId: work.id, title, version: typeof version === 'number' ? version : 0, installedAt: Date.now() }
  localStorage.setItem(MAP_KEY, JSON.stringify(map))
  return work.id
}
