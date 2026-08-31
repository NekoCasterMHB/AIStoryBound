// app/utils/chapters.ts
// 预置小说全文加载(阅读页/预生成安装用)。不再按章节切分:统一返回单段全文,
// 提取管线(splitUnits)按字数分块,不依赖章节结构。
import type { ChapterSegment, PresetNovelRow } from '#shared/novel'
import { getCachedPreset, saveCachedPreset } from './presetStore'

/** 清洗:去掉 BOM/\r、合并连续空行 */
function normalizePresetText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

export interface LoadedPresetChapters {
  chapters: ChapterSegment[]
  title: string
}

/**
 * 加载预置小说全文(单段):IndexedDB 缓存优先(可离线),未命中则经 /api/presets/[id]/download
 * 下载整份 TXT 后包装为单段并回写缓存。标题取缓存的 meta / 服务端元数据,兜底用 id。
 */
export async function loadPresetChapters(id: string): Promise<LoadedPresetChapters> {
  const cached = await getCachedPreset(id).catch(() => null)
  if (cached?.text?.trim()) {
    return { chapters: [{ title: '', content: normalizePresetText(cached.text) }], title: cached.meta.title || id }
  }

  // 元数据(标题等)先走一次轻量接口,失败不阻塞正文下载
  let meta: PresetNovelRow | null = null
  try {
    meta = await $fetch<PresetNovelRow>(`/api/presets/${id}`)
  } catch {
    // 元数据拿不到时用 id 兜底
  }

  const res = await fetch(`/api/presets/${id}/download`)
  if (!res.ok) throw new Error(`下载失败 (${res.status})`)
  const raw = await res.text()
  const content = normalizePresetText(raw)
  if (!content) throw new Error('文本为空或下载失败')

  // 写入 IndexedDB 持久化(失败不阻塞阅读)
  void saveCachedPreset(
    meta ?? { id, title: id, author: null, genre: null, description: null, cover_emoji: null },
    raw
  ).catch((e) => { console.error('[preset cache] save failed:', e) })

  return { chapters: [{ title: '', content }], title: meta?.title || id }
}
