// app/utils/shareZip.ts
// 游戏会话「分享全部」:作品 + 会话 + 剧情打包为 ZIP(fflate 同步压缩,全本地);
// 书架端「导入 ZIP 分享包」:校验格式与结构后,作为新的个人作品入库。
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { uuid, normalizeCharacterCards } from '#shared/novel'
import type { ChapterSegment, HeatLevel, KinkProfileEntry, LocalGame, LocalWork, WorldOverlay } from '#shared/novel'
import { SHARE_FORMAT, SHARE_VERSION } from '#shared/share-format'
import { buildGameTxt, buildWorkTxt, sanitizeFilename } from './exportStory'

/** 分享包格式标识:manifest.json 中的 format 字段,与本应用导出的包互相匹配(常量定义在 shared/share-format) */
export { SHARE_FORMAT, SHARE_VERSION }
/** 单文件上限:超过视为异常(防异常大包拖垮浏览器) */
const MAX_ZIP_BYTES = 64 * 1024 * 1024

interface ShareManifest {
  format: string
  version: number
  kind: 'game'
  title: string
  exportedAt: string
  /** 包内包含的文件清单(work.json / game.json / story.txt) */
  includes: string[]
}

export interface ExportGameZipArgs {
  title?: string
  playerName?: string
  chapter?: string | null
  /** 作品本体(章节正文 + 生成产物);缺失时包内只有会话与剧情 */
  work?: LocalWork | null
  game: LocalGame
  messages: LocalGame['messages']
  /** 导出时间;缺省用当前时间 */
  at?: Date
}

/**
 * 组装「分享全部」ZIP 包(data URL 之外的文件内容均为 UTF-8 JSON):
 *  - manifest.json:格式校验标识(导入端必须匹配)
 *  - work.json:完整作品(章节 + 实体/冲突/人物卡),导入端据此重建个人作品
 *  - game.json:完整游戏会话(含玩家行动,便于作者复盘)
 *  - story.txt:纯剧情文本(与「分享剧情」同款,方便直接阅读)
 */
export function buildGameShareZip(args: ExportGameZipArgs): Uint8Array {
  const { title, playerName, chapter, work, game, messages, at = new Date() } = args

  const includes: string[] = []
  const entries: Record<string, Uint8Array> = {}

  if (work) {
    includes.push('work.json')
    entries['work.json'] = strToU8(JSON.stringify(work, null, 2))
  }

  includes.push('game.json')
  entries['game.json'] = strToU8(JSON.stringify(game, null, 2))

  const story = buildGameTxt({ title, playerName, chapter, messages, at })
  if (story) {
    includes.push('story.txt')
    entries['story.txt'] = strToU8(story)
  }

  const manifest: ShareManifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    kind: 'game',
    title: title || work?.title || '未命名',
    exportedAt: at.toISOString(),
    includes
  }
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(entries, { level: 6 })
}

/** 下载「分享全部」ZIP 包(始终可导出,因包内至少含会话 JSON) */
export function downloadGameAsZip(args: ExportGameZipArgs): void {
  const zip = buildGameShareZip(args)
  // slice() 返回独立 ArrayBuffer 的新视图,满足 BlobPart 类型约束
  const blob = new Blob([zip.slice()], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(args.title || '故事')}-${sanitizeFilename(args.playerName || '玩家')}-分享包.zip`
  a.click()
  URL.revokeObjectURL(url)
}

// ---- 作品级分享包(书架「分享全部 ZIP」:整部作品 + 该作品全部游戏会话) ----

export interface ExportWorkZipArgs {
  /** 作品本体(章节正文 + 生成产物) */
  work: LocalWork
  /** 该作品的全部游戏会话(可选;包内附 game-N.json 供复盘,导入端重建作品时忽略) */
  games?: LocalGame[]
  /** 导出时间;缺省用当前时间 */
  at?: Date
}

/**
 * 组装作品分享 ZIP 包(与「分享全部」同格式,书架「导入 ZIP 分享包」可直接导入):
 *  - manifest.json / work.json / story.txt(作品全文)
 *  - game-N.json:该作品的每个游戏会话(导入端不读,仅供作者复盘/分享给读者看过程)
 */
export function buildWorkShareZip(args: ExportWorkZipArgs): Uint8Array {
  const { work, games = [], at = new Date() } = args

  const includes: string[] = []
  const entries: Record<string, Uint8Array> = {}

  includes.push('work.json')
  entries['work.json'] = strToU8(JSON.stringify(work, null, 2))

  const story = buildWorkTxt({ title: work.title, chapters: work.chapters })
  if (story) {
    includes.push('story.txt')
    entries['story.txt'] = strToU8(story)
  }

  games.forEach((g, i) => {
    includes.push(`game-${i + 1}.json`)
    entries[`game-${i + 1}.json`] = strToU8(JSON.stringify(g, null, 2))
  })

  const manifest: ShareManifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    kind: 'game',
    title: work.title || '未命名',
    exportedAt: at.toISOString(),
    includes
  }
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(entries, { level: 6 })
}

/** 下载作品分享 ZIP 包(书架「分享全部 ZIP」) */
export function downloadWorkAsZip(args: ExportWorkZipArgs): void {
  const zip = buildWorkShareZip(args)
  const blob = new Blob([zip.slice()], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(args.work.title || '作品')}-作品分享包.zip`
  a.click()
  URL.revokeObjectURL(url)
}

// ---- 导入校验(书架端) ----

/** 从 ZIP 中读取文本条目;缺失时返回 null(兼容外层套了一层目录名的分享包) */
function readEntry(files: Record<string, Uint8Array>, name: string): string | null {
  const base = name.split('/').pop() ?? name
  const key = Object.keys(files).find(k => !k.endsWith('/') && (k === name || k.split('/').pop() === base))
  const buf = key ? files[key] : null
  if (!buf) return null
  return strFromU8(buf)
}

/** 读取 manifest 并校验为本文档分享包,返回解析后的清单 */
function readManifest(files: Record<string, Uint8Array>): ShareManifest {
  const raw = readEntry(files, 'manifest.json')
  if (!raw) throw new Error('分享包缺少 manifest.json,只能导入本应用导出的 ZIP 分享包')
  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new Error('manifest.json 解析失败,文件已损坏')
  }
  const m = (manifest ?? {}) as Partial<ShareManifest>
  if (m.format !== SHARE_FORMAT) throw new Error('分享包格式不匹配,不是本应用导出的 ZIP')
  if (typeof m.version === 'number' && m.version > SHARE_VERSION) {
    throw new Error(`分享包版本过新(v${m.version}),请升级应用后再导入`)
  }
  return m as ShareManifest
}

/** work.json → 结构合法的 LocalWork(仅保留可确认字段,其余丢弃) */
function normalizeWork(raw: unknown): LocalWork {
  const r = (raw ?? {}) as Record<string, unknown>
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : ''
  if (!title) throw new Error('作品缺少标题')
  if (!Array.isArray(r.chapters) || r.chapters.length === 0) throw new Error('作品没有章节内容,无法导入')

  const chapters: ChapterSegment[] = []
  for (let i = 0; i < r.chapters.length; i++) {
    const c = r.chapters[i] as Record<string, unknown> | null
    if (!c || typeof c !== 'object' || typeof c.content !== 'string') {
      throw new Error(`第 ${i + 1} 章内容无效(缺少正文)`)
    }
    chapters.push({
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : `第${i + 1}章`,
      content: c.content
    })
  }
  if (!chapters.some(c => c.content.trim().length > 0)) throw new Error('作品正文为空,无法导入')

  // 生成产物:类型不符(如损坏/篡改)时整项丢弃,不阻止导入
  const overlay = ((): WorldOverlay | undefined => {
    const o = r.overlay as Record<string, unknown> | null
    if (!o || typeof o !== 'object') return undefined
    const heat: HeatLevel | undefined = o.heat === '淡' || o.heat === '中' || o.heat === '烈' ? o.heat : undefined
    const kinkProfile: KinkProfileEntry[] | undefined = Array.isArray(o.kinkProfile)
      ? o.kinkProfile.flatMap((k): KinkProfileEntry[] => {
          if (!k || typeof k !== 'object') return []
          const e = k as Record<string, unknown>
          if (typeof e.theme !== 'string' || !e.theme.trim()) return []
          return [{
            theme: e.theme,
            count: typeof e.count === 'number' && Number.isFinite(e.count) ? e.count : 1,
            dominantView: typeof e.dominantView === 'string' ? e.dominantView : null
          }]
        })
      : undefined
    return {
      title: typeof o.title === 'string' ? o.title : undefined,
      genre: typeof o.genre === 'string' ? o.genre : undefined,
      summary: typeof o.summary === 'string' ? o.summary : undefined,
      // 角色卡归一为当前 CharacterCard 形状:外部/旧版本 zip 可能把 appearance 存成结构化对象、personality 存成字符串
      characters: Array.isArray(o.characters) ? normalizeCharacterCards(o.characters) : undefined,
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : undefined,
      orientation: typeof o.orientation === 'string' ? o.orientation : undefined,
      setting: typeof o.setting === 'string' ? o.setting : undefined,
      heat,
      contentWarnings: Array.isArray(o.contentWarnings) ? o.contentWarnings.filter((t): t is string => typeof t === 'string') : undefined,
      tropes: Array.isArray(o.tropes) ? o.tropes.filter((t): t is string => typeof t === 'string') : undefined,
      kinkProfile
    }
  })()
  const entities = r.entities && typeof r.entities === 'object' ? r.entities as LocalWork['entities'] : undefined
  const conflicts = Array.isArray(r.conflicts) ? r.conflicts as LocalWork['conflicts'] : undefined
  const warnings = Array.isArray(r.warnings) ? r.warnings.filter(w => typeof w === 'string') as string[] : undefined
  const storyline = Array.isArray(r.storyline) ? r.storyline as LocalWork['storyline'] : undefined
  const characterArcs = Array.isArray(r.characterArcs) ? r.characterArcs as LocalWork['characterArcs'] : undefined

  const now = new Date().toISOString()
  return {
    // 导入即新作品:换新 id,避免与他人(或重复导入)的本地记录冲突
    id: uuid(),
    title,
    author: typeof r.author === 'string' && r.author.trim() ? r.author.trim() : undefined,
    createdAt: now,
    updatedAt: now,
    chapters,
    encoding: typeof r.encoding === 'string' ? r.encoding : undefined,
    syncStatus: 'local',
    tokensUsed: typeof r.tokensUsed === 'number' ? r.tokensUsed : undefined,
    entities,
    conflicts,
    warnings,
    overlay,
    storyline,
    characterArcs
  }
}

/**
 * 校验 ZIP 分享包字节并重建为个人作品(不落库,由调用方保存)。
 * 失败时抛出带中文说明的 Error,调用方按错误提示用户。
 */
export async function importWorkFromBytes(bytes: Uint8Array): Promise<LocalWork> {
  if (bytes.length > MAX_ZIP_BYTES) throw new Error('分享包过大(超过 64MB),无法导入')

  // ZIP 魔数 PK(空包为 PK\x05\x06)
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('不是有效的 ZIP 文件(文件头不正确)')
  }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error('ZIP 解析失败,文件已损坏或不是 ZIP 格式')
  }

  readManifest(files)

  const workRaw = readEntry(files, 'work.json')
  if (!workRaw) throw new Error('分享包缺少作品数据(work.json)')
  let parsed: unknown
  try {
    parsed = JSON.parse(workRaw)
  } catch {
    throw new Error('work.json 解析失败,文件已损坏')
  }
  return normalizeWork(parsed)
}

/** File 入口(书架「导入 ZIP 分享包」):读出字节后走 importWorkFromBytes */
export async function importWorkFromZip(file: File): Promise<LocalWork> {
  return importWorkFromBytes(new Uint8Array(await file.arrayBuffer()))
}
