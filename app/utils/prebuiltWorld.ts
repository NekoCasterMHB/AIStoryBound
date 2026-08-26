// app/utils/prebuiltWorld.ts
// 预置小说「预生成世界」客户端入口:管理员预生成的成书结果(见 scripts/prebuild-presets.ts)
// 经 /api/presets/:id/world 静态下发,用户直接使用 —— 0 token、无需跑生成管线,
// 组装 LocalWork 落本地书架后跳 /play 选角。未预生成的书(world 404)回退原自定义生成流程。
import type { CharacterCard, EntityConflict, LocalWork, PresetNovelRow, WorldEntities } from '#shared/novel'
import { ADULT_GENRE } from '#shared/world-build'
import { loadPresetChapters } from './chapters'
import { saveWork } from './worldGen'

/** /api/presets/:id/world 返回的预生成世界(不含章节正文,正文仍走 txt 静态资源) */
export interface PrebuiltWorld {
  id: string
  title: string
  author: string | null
  genre: string | null
  summary: string | null
  characters: CharacterCard[]
  entities: WorldEntities
  conflicts: EntityConflict[]
  warnings: string[]
  /** 管理员预生成时消耗的 token(仅展示用;对用户免费) */
  tokensUsed: number
  mode: 'full' | 'eco'
  generatedAt: string
  version: number
}

/** 拉取预生成世界;该书未预生成(404)返回 null */
export async function fetchPrebuiltWorld(presetId: string): Promise<PrebuiltWorld | null> {
  try {
    return await $fetch<PrebuiltWorld>(`/api/presets/${presetId}/world`)
  } catch (e) {
    if ((e as { status?: number })?.status === 404) return null
    throw e
  }
}

/** 用预生成世界组装 LocalWork 落本地书架(章节正文来自预置 txt 缓存/下载),返回 workId */
export async function installPrebuiltWork(preset: Pick<PresetNovelRow, 'id' | 'title' | 'author'>, world: PrebuiltWorld): Promise<string> {
  const { chapters } = await loadPresetChapters(preset.id)
  const now = new Date().toISOString()
  const work: LocalWork = {
    id: crypto.randomUUID(),
    title: world.title || preset.title,
    author: world.author ?? preset.author ?? undefined,
    createdAt: now,
    updatedAt: now,
    chapters,
    syncStatus: 'local',
    tokensUsed: 0, // 预生成世界对用户免费(管理员成本记录在 world.tokensUsed)
    entities: world.entities,
    conflicts: world.conflicts,
    warnings: world.warnings,
    overlay: {
      title: world.title || preset.title,
      genre: ADULT_GENRE,
      summary: world.summary ?? undefined,
      characters: world.characters
    }
  }
  await saveWork(work)
  return work.id
}
