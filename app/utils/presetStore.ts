// app/utils/presetStore.ts
// 预置小说全文的 IndexedDB 缓存:预览时自动下载并持久化,之后阅读/生成直接读本地缓存,
// 避免重复下载(可离线阅读)。Nuxt 会自动导入本文件导出。
import { db } from './localDb'
import type { CachedPreset, PresetNovelRow } from '../../shared/novel'

/**
 * 尝试读取缓存;未命中返回 null。
 * 缓存只在浏览器端存在,SSR/服务端直接返回 null。
 */
export async function getCachedPreset(id: string): Promise<CachedPreset | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    return (await (await db()).get('presets', id)) ?? null
  } catch {
    return null
  }
}

/** 把下载到的全文写入缓存(按 id 覆盖)。异常向上抛,由调用方决定是否忽略。 */
export async function saveCachedPreset(
  meta: Pick<PresetNovelRow, 'id' | 'title' | 'author' | 'genre' | 'description' | 'cover_emoji'>,
  text: string
): Promise<void> {
  const entry: CachedPreset = {
    id: meta.id,
    meta: {
      id: meta.id,
      title: meta.title,
      author: meta.author,
      genre: meta.genre,
      description: meta.description,
      cover_emoji: meta.cover_emoji
    },
    text,
    size: text.length,
    savedAt: new Date().toISOString()
  }
  const d = await db()
  await d.put('presets', entry)
}

/** 清除某本预置小说的缓存(如文本已过期需重新下载) */
export async function deleteCachedPreset(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await (await db()).delete('presets', id)
}

/** 调试用:列出本地已缓存的小说 id */
export async function listCachedPresets(): Promise<CachedPreset[]> {
  if (typeof indexedDB === 'undefined') return []
  return (await (await db()).getAll('presets')) ?? []
}
