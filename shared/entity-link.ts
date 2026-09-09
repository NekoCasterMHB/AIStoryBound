// shared/entity-link.ts
// 实体消歧 pass(管线 merge 之后、check 之前;docs/format-v2.md §11.1 分层与 §10.0 P4):
//  跨单元提取时同一角色可能以不同称呼被裂成多个条目(「林凡」/「凡哥」/「小凡」)——merge 的
//  名字键去重只处理完全同名 + 已提取 alias 的映射,这里补最后一道:
//  ① 代码预聚类(clusterCharacterCandidates):仅对名字高度相似的候选成簇,保守宁漏勿错;
//  ② AI 裁决(buildEntityLinkMessages / parseEntityLinkGroups):逐簇判断是否同一人,输出下标分组;
//  ③ 应用合并(applyEntityMerges):组的规范条目 = mentionCount 最高者,别名/数组/变体并集、
//     标量回落、计数求和、章节变体同段归并。
// 纯函数,前后端共用;不做任何 AI 调用(服务端 stepDisambiguate 传 relay)。
import type { CharacterChapterVariant, MergedCharacter } from './novel'

const norm = (s: string) => (s ?? '').toLowerCase().replace(/[\s·•‧・]/g, '')

/** 两个候选是否"性别互斥"(已知且不同 → 禁止合并,强信号) */
function genderConflicts(a: MergedCharacter, b: MergedCharacter): boolean {
  const g1 = (a.gender ?? '').trim()
  const g2 = (b.gender ?? '').trim()
  if (!g1 || !g2 || g1 === '未知' || g2 === '未知') return false
  return (g1.includes('女') !== g2.includes('女'))
}

/** 名字模式相似(代码级,保守):
 *  - 包含:短名(≥2 字)是长名的子串(林凡 ⊂ 林凡然);
 *  - 昵称:小/老/阿 + X,或 X + 儿/仔/哥/姐/弟/妹,X 等于对方全名或对方末 1~2 字(小凡↔林凡、凡哥↔林凡)。 */
function nameSimilar(a: string, b: string): boolean {
  const n1 = norm(a)
  const n2 = norm(b)
  if (!n1 || !n2 || n1 === n2) return false
  if (n1.includes(n2) || n2.includes(n1)) return Math.min(n1.length, n2.length) >= 2
  const nick = (x: string, full: string): boolean => {
    const m1 = x.match(/^[小老阿](.+)$/u)
    if (m1 && (m1[1] === full || (full.length >= 2 && full.endsWith(m1[1]!)))) return true
    const m2 = full.match(/^(.+?)(儿|仔|哥|姐|弟|妹)$/u)
    if (m2 && (m2[1] === x || (x.length >= 2 && x.endsWith(m2[1]!)))) return true
    return false
  }
  return nick(n1, n2) || nick(n2, n1)
}

/** 单个簇允许的最大候选数(再相似也只在小组内裁决,控成本与误合并面) */
const MAX_CLUSTER_SIZE = 4
/** 单本书最多送 AI 裁决的簇数(按合计提及数取最靠前的;超出部分保持独立,宁漏勿错) */
export const MAX_LINK_CLUSTERS = 12

/** 代码预聚类:返回候选簇(每簇为 entities.characters 的下标数组)。无相似对返回空数组。 */
export function clusterCharacterCandidates(chars: MergedCharacter[]): number[][] {
  const n = chars.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)))
  const union = (x: number, y: number) => {
    parent[find(x)!] = find(y)!
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (genderConflicts(chars[i]!, chars[j]!)) continue
      if (find(i) === find(j)) continue
      const names = (c: MergedCharacter) => [c.name ?? '', ...(c.alias ?? [])]
      const similar = names(chars[i]!).some(a => a.trim() && names(chars[j]!).some(b => nameSimilar(a, b)))
      if (similar) union(i, j)
    }
  }
  const byRoot = new Map<number, Set<number>>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, new Set())
    byRoot.get(r)!.add(i)
  }
  const clusters: number[][] = []
  for (const members of byRoot.values()) {
    if (members.size < 2) continue
    clusters.push([...members].sort((a, b) => a - b).slice(0, MAX_CLUSTER_SIZE))
  }
  // 按合计提及数取最靠前的簇(裂开的大都是高频角色;长尾单提无收益)
  clusters.sort((a, b) => sumMentions(chars, b) - sumMentions(chars, a))
  return clusters.slice(0, MAX_LINK_CLUSTERS)
}

function sumMentions(chars: MergedCharacter[], idxs: number[]): number {
  return idxs.reduce((s, i) => s + (chars[i]?.mentionCount ?? 0), 0)
}

/** 实体消歧裁决请求(逐簇一次调用):输入各候选的画像与证据,输出同一个人分组 */
export function buildEntityLinkMessages(
  title: string,
  chars: MergedCharacter[],
  cluster: number[]
): { system: string, user: string } {
  const tr = (s: string | null | undefined, n: number) => (s ?? '').trim().slice(0, n)
  const candidates = cluster.map((i) => {
    const c = chars[i]!
    const first = c.sources?.[0]?.chapter
    const last = c.sources?.[c.sources.length - 1]?.chapter
    return {
      index: i,
      name: c.name,
      alias: (c.alias ?? []).slice(0, 6),
      gender: c.gender ?? null,
      identity: tr(c.identity, 40) || null,
      appearance: tr(c.appearance, 60) || null,
      background: tr(c.background, 80) || null,
      mentions: c.mentionCount ?? 0,
      chapters: first != null && last != null ? [first, last] : null,
      quote: tr(c.quote, 80) || null
    }
  })
  const system = '你必须只输出一个合法的 JSON 对象,不要输出任何其他文字、注释或 Markdown 围栏。'
  const user = `小说《${title}》的分段提取把下面这些人物候选当作了独立条目。请判断哪些候选实际是同一个人(同一角色的不同称呼/名字变体)。\n`
    + `输出结构必须满足:\n{"groups": [[候选下标数组], ...]}\n\n`
    + `候选(下标即 index):\n${candidates.map(c => JSON.stringify(c)).join('\n')}\n\n`
    + '规则:\n'
    + '1. groups 里每个 index 必须恰好出现一次;单独一组表示独立人物。\n'
    + '2. 只有明显证据(称呼习惯一致、性别身份吻合、经历衔接)才合并;不确定就分开,宁漏勿错。\n'
    + '3. 名字相似但性别不同、或身份经历明显矛盾的,不要合并。\n'
    + '4. 不要编造候选之外的下标。'
  return { system, user }
}

/** 解析裁决结果:非法下标丢弃、重复下标以首次分组为准、未提及的下标按独立处理;返回多成员组 */
export function parseEntityLinkGroups(raw: unknown, cluster: number[]): number[][] {
  const allowed = new Set(cluster)
  const owner = new Map<number, number>() // index → 组号
  const groups: number[][] = []
  const arr = (raw as { groups?: unknown } | null)?.groups
  if (Array.isArray(arr)) {
    for (const g of arr) {
      if (!Array.isArray(g)) continue
      let gi = -1
      for (const v of g) {
        const i = typeof v === 'number' ? v : Number.parseInt(String(v), 10)
        if (!allowed.has(i) || owner.has(i)) continue
        if (gi < 0) gi = groups.push([]) - 1
        owner.set(i, gi)
        groups[gi]!.push(i)
      }
    }
  }
  for (const i of cluster) {
    if (!owner.has(i)) groups.push([i])
  }
  return groups.filter(g => g.length > 1)
}

/** 数组字段的归一去重并集 */
function unionBy<T>(lists: (T[] | undefined)[], keyOf: (v: T) => string): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const v of list ?? []) {
      const k = keyOf(v)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(v)
    }
  }
  return out
}
const arrKey = (v: string) => norm(v)

/** 章节变体归并:按段排序,同段 patch 后写覆盖前写、status 取后非空(与 merge 阶段同语义)。
 *  lists 顺序即覆盖顺序:调用方把规范条目的变体放最后(同段冲突时以高频条目为准)。 */
function mergeVariants(lists: (CharacterChapterVariant[] | undefined)[]): CharacterChapterVariant[] {
  const out: CharacterChapterVariant[] = []
  for (const v of unionBy(lists, v => `${v.stage}:${JSON.stringify(v.patch)}`)) {
    const last = out[out.length - 1]
    if (last && last.stage === v.stage) {
      last.patch = { ...last.patch, ...v.patch }
      if (v.status) last.status = v.status
    } else {
      out.push({ ...v, patch: { ...v.patch } })
    }
  }
  return out.sort((a, b) => a.stage - b.stage)
}

/** 应用裁决分组:每组保留 mentionCount 最高的条目为规范条目,其余并入后删除。
 *  返回新数组(不改入参)与被合并掉的条目数。 */
export function applyEntityMerges(
  chars: MergedCharacter[],
  groups: number[][]
): { characters: MergedCharacter[], mergedAway: number } {
  let mergedAway = 0
  const remove = new Set<number>()
  for (const group of groups) {
    if (group.length < 2 || !group.every(i => i >= 0 && i < chars.length)) continue
    const sorted = [...group].sort((a, b) =>
      (chars[b]!.mentionCount ?? 0) - (chars[a]!.mentionCount ?? 0) || a - b)
    const canonicalIdx = sorted[0]!
    const canon = { ...chars[canonicalIdx]! }
    for (const i of sorted.slice(1)) {
      const other = chars[i]!
      remove.add(i)
      mergedAway++
      canon.mentionCount = (canon.mentionCount ?? 0) + (other.mentionCount ?? 0)
      canon.alias = unionBy([canon.alias, other.alias], arrKey)
      canon.personality = unionBy([canon.personality, other.personality], arrKey)
      canon.speech_style = unionBy([canon.speech_style, other.speech_style], arrKey)
      canon.abilities = unionBy([canon.abilities, other.abilities], arrKey)
      canon.goals = unionBy([canon.goals, other.goals], arrKey)
      canon.fears = unionBy([canon.fears, other.fears], arrKey)
      canon.secrets = unionBy([canon.secrets, other.secrets], arrKey)
      canon.identityVariants = unionBy([canon.identityVariants, other.identityVariants], arrKey)
      canon.appearanceVariants = unionBy([canon.appearanceVariants, other.appearanceVariants], arrKey)
      canon.backgroundVariants = unionBy([canon.backgroundVariants, other.backgroundVariants], arrKey)
      canon.relationships = unionBy(
        [canon.relationships, other.relationships],
        r => `${norm(r.name)}:${norm(r.type)}`
      )
      canon.kinks = unionBy([canon.kinks, other.kinks], k => norm(k.theme))
      // 标量:规范条目没有才回落;身份/外貌/背景的其它表述已进变体,不覆盖
      for (const f of ['identity', 'appearance', 'background'] as const) {
        if (!String(canon[f] ?? '').trim() && String(other[f] ?? '').trim()) canon[f] = other[f]
      }
      if (!canon.gender && other.gender) canon.gender = other.gender
      if (!canon.age && other.age) canon.age = other.age
      if (!canon.quote && other.quote) canon.quote = other.quote
      if (canon.dead !== true && other.dead === true) canon.dead = true
      // 证据与变体(规范条目放最后:同段冲突以其为准)
      canon.sources = [...(other.sources ?? []), ...(canon.sources ?? [])].slice(-40)
      canon.chapterVariants = mergeVariants([other.chapterVariants, canon.chapterVariants])
      if (canon.sex || other.sex) canon.sex = { ...other.sex, ...canon.sex }
    }
    chars[canonicalIdx] = canon
  }
  return { characters: chars.filter((_, i) => !remove.has(i)), mergedAway }
}

/** 簇内「被并条目名/别名 → 规范条目名」映射(键为 norm 归一名;别名经 norm 后碰撞则先到先得)。
 *  规范条目选取与 applyEntityMerges 同规则:mentionCount 最高,平序取下标靠前。
 *  供消歧后回写 storyline.cast / 段角色文件键 / arcs 事实底稿,消除消歧前用名残留。 */
export function buildAliasNameMap(chars: MergedCharacter[], groups: number[][]): Map<string, string> {
  const map = new Map<string, string>()
  for (const group of groups) {
    if (group.length < 2 || !group.every(i => i >= 0 && i < chars.length)) continue
    const sorted = [...group].sort((a, b) => (chars[b]!.mentionCount ?? 0) - (chars[a]!.mentionCount ?? 0) || a - b)
    const canonName = chars[sorted[0]!]!.name
    for (const i of sorted.slice(1)) {
      const c = chars[i]!
      const nameKey = norm(c.name)
      if (nameKey && !map.has(nameKey)) map.set(nameKey, canonName)
      for (const a of c.alias ?? []) {
        const k = norm(a)
        if (k && !map.has(k)) map.set(k, canonName)
      }
    }
  }
  return map
}
