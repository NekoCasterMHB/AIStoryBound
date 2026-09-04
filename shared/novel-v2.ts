// shared/novel-v2.ts
// 作品格式 v2(aisb-book)权威类型与序列化(见 docs/format-v2.md)。
// 设计要点:
//  - 人物卡用中文保留键 + 自由区(profile),键即文档,值形状容忍(见 character-interpreter)。
//  - 段(segments/NNN)= 正典(全局真相 + 节点[] 推进锚)+ 该段有内容的角色文件。
//  - characters/ = 跨段不变基础设定(merge 后代码翻译生成)。
//  - games/ = 游玩/会话(与作品解耦)。
// 本文件纯类型 + 同步序列化,前后端/服务端均可引用(fflate 在两端均可用)。
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

/** 格式标识与版本 */
export const BOOK2_FORMAT = 'aisb-book'
export const BOOK2_VERSION = 2

/** 单文件上限(参考现有分享包 64MB) */
export const BOOK2_MAX_ZIP_BYTES = 64 * 1024 * 1024

// ---- 类型定义 ----

/** 每段事件里程碑:段内推进/引导的锚(数量由 AI 自主决定,描述尽量详细) */
export interface SegmentNode {
  /** 段内序号(按发生顺序 0..N-1) */
  n: number
  /** 事件详细描述(起因/经过/转折/结果,不做短标签压缩) */
  事件: string
}

/** 一段的全局真相(正典):细纲 + 节点[] + 原文,唯一真源 */
export interface SegmentCanon {
  /** 段序(排序键) */
  index: number
  /** 时间点/剧情转折标题(如 相识期/恋爱期/婚后/分手后) */
  title?: string
  /** 出场人物;值须与 characters/ 某文件的「姓名」一致 */
  cast: string[]
  /** 本段叙事主角(姓名,可数组);引擎作全局 NPC 锚,未标回退 role==='主角' */
  主角?: string[]
  /** 一句可读细纲(人类浏览) */
  beat: string
  /** 事件里程碑数组(推进/引导锚,AI 标转折时一并生成) */
  节点?: SegmentNode[]
  /** 场景 */
  place?: string
  /** 起承转合 */
  turn?: string
  /** 结尾钩子 */
  hook?: string
  /** 本段正文原文(全局真相,段自包含) */
  text: string
}

/** 该角色本段文件:本段状态 + 剧情(仅建有内容的角色) */
export interface SegmentCharacterFile {
  /** 关联锚(与 cast / characters 的「姓名」一致) */
  姓名: string
  /** 本段状态:浅覆盖 characters/ 基础卡 */
  状态?: Record<string, unknown>
  /** 本段剧情/行动线/视角(角色弧线的"段切片") */
  剧情?: string
  /** 自由区:任意键任意值 */
  [key: string]: unknown
}

/** 一段 = 正典 + 该段有内容的角色文件 */
export interface SegmentDir {
  canon: SegmentCanon
  /** 该段有可用状态/剧情的角色文件(key=姓名) */
  characters: Record<string, SegmentCharacterFile>
}

/** characters/ 基础卡:中文保留键 + 自由区(profile) */
export interface BookCharacter {
  姓名: string
  角色?: string
  身份?: string | null
  外貌?: string | null
  性格?: string[]
  背景?: string | null
  目标?: string[]
  关系?: { 对象: string, 值?: number, 说明?: string }[]
  别名?: string[]
  性欲强度?: number | null
  耐心?: number | null
  心软?: number | null
  玩法喜好?: { 主题: string, 态度?: string | null, 角色?: string | null, 细节?: string | null }[]
  成人属性?: Record<string, unknown>
  首次出场?: string | null
  已死亡?: boolean | null
  弧线?: { summary?: string, detail?: string }
  /** 自由区:任意键任意值(渲染器通用展示 + 进 AI 补充设定) */
  [key: string]: unknown
}

/** 一个游戏会话(与作品解耦;内部沿用现有 game JSON 结构,见 §5) */
export interface BookGame {
  id: string
  /** session.json 承载全部游玩数据(不拆散到多处) */
  session: unknown
}

/** 完整 v2 作品(zip 的运行时表示) */
export interface BookDoc {
  manifest: AisbBookManifest
  /** 归档全文(仅阅读,不入逻辑) */
  fulltext: string
  /** 按段组织;key=段文件夹名(如 '000') */
  segments: Record<string, SegmentDir>
  /** 跨段不变基础设定;key=姓名 */
  characters: Record<string, BookCharacter>
  /** 游戏会话(可空) */
  games?: Record<string, BookGame>
}

export interface AisbBookManifest {
  format: typeof BOOK2_FORMAT
  version: number
  kind: 'book'
  title: string
  author?: string
  segmentCount: number
  charCount: number
  tags?: string[]
  orientation?: string
  heat?: '淡' | '中' | '烈'
  setting?: string
  exportedAt?: string
}

// ---- 序列化 ----

/** v2 目录文件名的固定约定 */
const ENTRY_MANIFEST = 'manifest.json'
const ENTRY_FULLTEXT = (title: string) => `${sanitizePath(title)}.txt`
const ENTRY_CANON = (seg: string) => `segments/${seg}/正典.json`
const ENTRY_CHARACTER = (seg: string, name: string) => `segments/${seg}/${sanitizePath(name)}.json`
const ENTRY_BOOK_CHAR = (name: string) => `characters/${sanitizePath(name)}.json`
const ENTRY_GAME = (id: string) => `games/${sanitizePath(id)}/session.json`

/** 只保留文件安全的字符(角色名/书名做文件名);控制字符一并替换 */
function sanitizePath(s: string): string {
  // eslint-disable-next-line no-control-regex -- 需剔除 \u0000-\u001f 控制字符
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
}

/** BookDoc → zip 字节(manifest + <书名>.txt + segments/* + characters/* + games/*) */
export function bookDocToZip(doc: BookDoc): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  entries[ENTRY_MANIFEST] = strToU8(JSON.stringify(doc.manifest, null, 2))
  entries[ENTRY_FULLTEXT(doc.manifest.title)] = strToU8(doc.fulltext)

  for (const [segName, seg] of Object.entries(doc.segments)) {
    entries[ENTRY_CANON(segName)] = strToU8(JSON.stringify(seg.canon, null, 2))
    for (const [name, ch] of Object.entries(seg.characters)) {
      entries[ENTRY_CHARACTER(segName, name)] = strToU8(JSON.stringify(ch, null, 2))
    }
  }
  for (const [name, ch] of Object.entries(doc.characters)) {
    entries[ENTRY_BOOK_CHAR(name)] = strToU8(JSON.stringify(ch, null, 2))
  }
  for (const [id, g] of Object.entries(doc.games ?? {})) {
    entries[ENTRY_GAME(id)] = strToU8(JSON.stringify(g.session))
  }
  return zipSync(entries, { level: 6 })
}

/** zip 字节 → BookDoc(容错:缺 segments/characters 时给空;结构非法字段丢弃) */
export function bookZipToDoc(bytes: Uint8Array): BookDoc {
  if (bytes.length > BOOK2_MAX_ZIP_BYTES) throw new Error('分享包过大(超过 64MB),无法解析')
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error('ZIP 解析失败,文件已损坏或不是 ZIP 格式')
  }
  const str = (name: string): string | null => {
    const key = Object.keys(files).find(k => !k.endsWith('/') && (k === name || k.split('/').pop() === name))
    const buf = key ? files[key] : null
    return buf ? strFromU8(buf) : null
  }
  const json = <T>(name: string): T | null => {
    const raw = str(name)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  const manifest = json<AisbBookManifest>(ENTRY_MANIFEST)
  if (!manifest || manifest.format !== BOOK2_FORMAT) throw new Error('分享包格式不匹配,不是本应用导出的 v2 包')

  const segments: BookDoc['segments'] = {}
  for (const [path, buf] of Object.entries(files)) {
    // segments/<seg>/<name>.json
    const m = path.match(/^segments\/([^/]+)\/(正典|[^/]+)\.json$/)
    if (!m) continue
    const segName = m[1] as string
    const isCanon = (m[2] as string) === '正典'
    const parsed = JSON.parse(strFromU8(buf)) as Record<string, unknown> | null
    if (!parsed) continue
    const dir = segments[segName] ?? (segments[segName] = { canon: undefined as unknown as SegmentCanon, characters: {} })
    if (isCanon) {
      dir.canon = parsed as unknown as SegmentCanon
    } else {
      const name = (parsed['姓名'] as string | undefined) ?? (m[2] as string)
      dir.characters[name] = parsed as unknown as SegmentCharacterFile
    }
  }

  const characters: BookDoc['characters'] = {}
  for (const [path, buf] of Object.entries(files)) {
    const m = path.match(/^characters\/([^/]+)\.json$/)
    if (!m) continue
    const parsed = JSON.parse(strFromU8(buf)) as BookCharacter
    if (parsed['姓名']) characters[parsed['姓名']] = parsed
  }

  const games: BookDoc['games'] = {}
  for (const [path, buf] of Object.entries(files)) {
    const m = path.match(/^games\/([^/]+)\/session\.json$/)
    if (!m) continue
    const id = m[1] as string
    games[id] = { id, session: JSON.parse(strFromU8(buf)) }
  }

  const title = manifest.title || '未命名'
  return {
    manifest,
    fulltext: str(ENTRY_FULLTEXT(title)) ?? '',
    segments,
    characters,
    ...(Object.keys(games).length ? { games } : {})
  }
}
