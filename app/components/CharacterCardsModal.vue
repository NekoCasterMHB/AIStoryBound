<script setup lang="ts">
// 编辑角色卡弹窗:修改/新增/删除本地作品 overlay.characters;
// v1 作品保存回 IndexedDB works,v2(book2)作品写回 book2 zip 的 characters/ 层
// 入口:书架「本地作品」卡片上的「角色卡」按钮;保存后由父组件刷新列表
import { saveWork, getWork } from '../utils/worldGen'
import { loadWorkView, saveBook2Characters, updateBook2, updateBook2World } from '../utils/bookStoreV2'
import { listLocalGames, saveLocalGame } from '../utils/gameStore'
import { desireTierName, DESIRE_TIERS, SEX_TEXT_KEYS } from '#shared/novel'
import type { CharacterArc, CharacterCard, SexAttrs, SexTextField } from '#shared/novel'
import type { BookDoc } from '#shared/novel-v2'

const props = defineProps<{ workId: string }>()
const emit = defineEmits<{ saved: [] }>()

const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const workTitle = ref('')
const draft = ref<CharacterCard[]>([])
const characterArcs = ref<CharacterArc[]>([])
/** 当前作品真源(book2 才有可持久化的段文件;聚合分段编辑只对它开放) */
const workSource = ref<'book2' | 'works'>('book2')
/** book2 打开时的全量段文档深拷贝:分段编辑的中间态,保存时与最新数据 diff 后合并 */
const segDocWork = ref<BookDoc | null>(null)
const selIdx = ref(0)
const saving = ref(false)
const loaded = ref(false)
const loadErr = ref('')

const sel = computed(() => draft.value[selIdx.value])

/** 左侧角色列表顺序:主角置前,其余保持原相对顺序(仅展示排序,不改 draft) */
const orderedCardIndexes = computed<number[]>(() => {
  const idx = draft.value.map((_, i) => i)
  idx.sort((a, b) => {
    const ra = draft.value[a]?.role
    const rb = draft.value[b]?.role
    if (ra === rb) return a - b
    if (ra === '主角') return -1
    if (rb === '主角') return 1
    return a - b
  })
  return idx
})

/** 选项不足时把当前值并入候选(避免 AI 生成的非标准值在选择器里丢失) */
function withCurrent(current: string | null | undefined, base: string[]): string[] {
  const v = (current ?? '').trim()
  return v && !base.includes(v) ? [v, ...base] : base
}

const roleSel = computed({
  get: () => sel.value?.role ?? '配角',
  set: (v: string) => { if (sel.value) sel.value.role = v }
})

watch(open, async (v) => {
  if (!v) return
  saving.value = false
  loaded.value = false
  loadErr.value = ''
  selIdx.value = 0
  // loadWorkView 统一入口:角色卡 = v2 语义卡(单一解释器;profile 自由区随卡)
  const view = await loadWorkView(props.workId)
  if (!view) {
    loadErr.value = '本地未找到该作品'
    loaded.value = true
    return
  }
  workTitle.value = view.title
  draft.value = JSON.parse(JSON.stringify(view.characters))
  characterArcs.value = JSON.parse(JSON.stringify(view.world.characterArcs ?? []))
  // book2 真源:拷贝段文档供分段剧情/状态聚合编辑;v1(works 源)没有可持久化的段,跳过
  workSource.value = view.source
  segDocWork.value = view.source === 'book2'
    ? JSON.parse(JSON.stringify(view.doc)) as BookDoc
    : null
  expandedSegs.value.clear()
  rebuildAttrRows()
  rebuildArcDraft()
  rebuildSegDrafts()
  loaded.value = true
})

// 切换角色时重建属性行与分段草稿(弧线草稿先建,段草稿要挂它的 beat 引用)
watch(selIdx, () => {
  rebuildAttrRows()
  rebuildArcDraft()
  rebuildSegDrafts()
})

/** 名字归一化(去空白;弧线按角色名对齐用) */
function arcKey(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, '').trim()
}

/** 角色对应的独立故事线(工作副本,弹窗内可编辑,保存时整层写回) */
function arcOfCard(name: string | undefined): CharacterArc | undefined {
  if (!name || !characterArcs.value.length) return undefined
  const key = arcKey(name)
  return characterArcs.value.find(a => arcKey(a.character) === key)
    ?? characterArcs.value.find(a => arcKey(a.character).includes(key) || key.includes(arcKey(a.character)))
}

/** 当前选中角色对应的独立故事线 */
const selArc = computed(() => arcOfCard(sel.value?.name))

// ---- 角色列表操作 ----
function addCard() {
  draft.value.push({ name: `角色 ${draft.value.length + 1}`, role: '配角', personality: [] })
  selIdx.value = draft.value.length - 1
}

function removeCard(i: number) {
  const name = draft.value[i]?.name || '未命名角色'
  draft.value.splice(i, 1)
  if (selIdx.value >= draft.value.length) selIdx.value = draft.value.length - 1
  if (draft.value.length) toast.add({ title: `已删除角色「${name}」`, color: 'neutral' })
}

// ---- 关系编辑 ----
function addRel() {
  if (!sel.value) return
  ;(sel.value.relationships ??= []).push({ name: '', type: '', value: 0 })
}

function removeRel(i: number) {
  sel.value?.relationships?.splice(i, 1)
}

// ---- 题材喜好(亚文化玩法)编辑 ----
const KINK_VIEWS = ['喜欢', '厌恶', '接受', '无感', '未知']
const KINK_ROLES = ['承受', '施予', '双方', '未知']
function addKink() {
  if (!sel.value) return
  ;(sel.value.kinks ??= []).push({ theme: '', view: null, role: null, detail: null })
}

function removeKink(i: number) {
  sel.value?.kinks?.splice(i, 1)
}

// ---- 性爱属性编辑(文本字段与 condom 三态) ----
const CONDOM_OPTS: string[] = ['是', '否', '未知']
function sexField(key: SexTextField) {
  return computed({
    get: () => sel.value?.sex?.[key] ?? '',
    set: (v: string) => {
      if (!sel.value) return
      const cur: Partial<SexAttrs> = { ...(sel.value.sex ?? {}) }
      const t = v.trim()
      cur[key] = t || undefined
      // 存储前剔除空值,只保留实际填写字段(condom 布尔三态单独保留)
      const cleaned: Partial<SexAttrs> = {}
      for (const k of SEX_TEXT_KEYS) {
        const val = cur[k]
        if (val) cleaned[k] = val
      }
      if (cur.condom === true || cur.condom === false) cleaned.condom = cur.condom
      sel.value.sex = Object.keys(cleaned).length ? cleaned : undefined
    }
  })
}
const positionsModel = sexField('positions')
const habitsModel = sexField('habits')
const teaseModel = sexField('tease')
const skillModel = sexField('skill')
const memberModel = sexField('member')
const staminaModel = sexField('stamina')
const figureModel = sexField('figure')
const fingersModel = sexField('fingers')
const condomModel = computed(() => {
  const v = sel.value?.sex?.condom
  return v == null ? '未知' : v ? '是' : '否'
})
function setCondom(v: unknown) {
  if (!sel.value) return
  const cur = { ...(sel.value.sex ?? {}) }
  if (v === '是') cur.condom = true
  else if (v === '否') cur.condom = false
  else delete cur.condom
  sel.value.sex = Object.keys(cur).length ? cur : undefined
}

// ---- 数值字段(空视为未知,null) ----
function numOrNull(v: string | number | null | undefined): number | null {
  if (v === '' || v == null || Number.isNaN(Number(v))) return null
  return Math.min(100, Math.max(0, Math.round(Number(v))))
}

function relNum(v: string | number | null | undefined): number {
  if (v === '' || v == null || Number.isNaN(Number(v))) return 0
  return Math.min(100, Math.max(-100, Math.round(Number(v))))
}

// ---- 属性(键:值)自由编辑 ----
// A 类描述字段注册表:命中这些保留中文键 → 写回 CharacterCard 英文语义字段(引擎结构化消费,落库仍为保留键);
// 其余任意新键 → profile 自由区(引擎以「补充设定」注入,见 docs/format-v2.md §8)。「未知」等同空,不写、不占行。
// 机械/结构化字段(姓名/角色/关系/耐心/心软/性欲强度/玩法喜好/成人属性)仍走下方专用编辑区,不进本表;
// 「已死亡」不在基础卡编辑(死亡以段状态键表达,见下方「分段剧情 / 状态」)。
const DESC_FIELDS: { cn: string, prop: string, type: 'text' | 'longtext' | 'tags' }[] = [
  { cn: '别名', prop: 'alias', type: 'text' },
  { cn: '性别', prop: 'gender', type: 'text' },
  { cn: '年龄', prop: 'age', type: 'text' },
  { cn: '身份', prop: 'identity', type: 'text' },
  { cn: '首次出场', prop: 'first_appearance', type: 'text' },
  { cn: '外貌', prop: 'appearance', type: 'longtext' },
  { cn: '性格', prop: 'personality', type: 'tags' },
  { cn: '说话风格', prop: 'speech_style', type: 'tags' },
  { cn: '背景', prop: 'background', type: 'longtext' },
  { cn: '能力', prop: 'abilities', type: 'tags' },
  { cn: '目标', prop: 'goals', type: 'tags' },
  { cn: '恐惧', prop: 'fears', type: 'tags' },
  { cn: '秘密', prop: 'secrets', type: 'tags' }
]
const DESC_BY_CN = new Map(DESC_FIELDS.map(f => [f.cn, f]))

type AttrType = 'text' | 'text-multi' | 'tags' | 'list' | 'number' | 'boolean' | 'object'
/** 自由键值类型(任意键;键名命中注册表自动转语义行) */
const FREE_TYPES: { value: AttrType, label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'text-multi', label: '多行' },
  { value: 'list', label: '列表' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '开关' },
  { value: 'object', label: '对象' }
]

interface AttrRow {
  /** desc:命中保留中文键(键名只读,按注册形态编辑);free:自由键(键名/类型可改,进 profile) */
  scope: 'desc' | 'free'
  key: string
  type: AttrType
  /** text/text-multi/object 为整段缓冲,list 每行/逗号一项,object 为 JSON 文本 */
  text: string
  /** tags 字段(性格/能力等)标签缓冲 */
  tags: string[]
}

/** 当前选中卡的属性行(随 sel 切换重建;输入即写回,保证光标不丢) */
const attrRows = ref<AttrRow[]>([])

/** 自由键条目(类型按值推断,兼容旧自由区数据) */
function freeRowOf(key: string, v: unknown): AttrRow {
  let type: AttrType = 'text'
  let text = ''
  if (Array.isArray(v)) {
    type = 'list'
    text = (v as unknown[]).map(x => String(x)).join('\n')
  } else if (typeof v === 'number') {
    type = 'number'
    text = String(v)
  } else if (typeof v === 'boolean') {
    type = 'boolean'
    text = v ? '是' : '否'
  } else if (v && typeof v === 'object') {
    type = 'object'
    text = JSON.stringify(v)
  } else {
    type = 'text'
    text = v == null ? '' : String(v)
  }
  return { scope: 'free', key, type, text, tags: [] }
}

function rebuildAttrRows() {
  const c = sel.value
  const rows: AttrRow[] = []
  if (c) {
    const card = c as unknown as Record<string, unknown>
    for (const f of DESC_FIELDS) {
      const raw = card[f.prop]
      if (f.type === 'tags') {
        const tags = Array.isArray(raw) ? raw.map(t => String(t).trim()).filter(t => t && t !== '未知') : []
        if (tags.length) rows.push({ scope: 'desc', key: f.cn, type: f.type, text: '', tags })
      } else {
        const s = raw == null ? '' : String(raw).trim()
        if (s && s !== '未知') rows.push({ scope: 'desc', key: f.cn, type: f.type, text: s, tags: [] })
      }
    }
    for (const [k, v] of Object.entries(c.profile ?? {})) {
      if (DESC_BY_CN.has(k)) continue // 防御:保留键不会出现在 profile
      rows.push(freeRowOf(k, v))
    }
  }
  attrRows.value = rows
}

/** 自由行缓冲 → 值(空/解析失败 → undefined,即该键不写入) */
function freeValueOf(row: AttrRow): unknown {
  const s = row.text.trim()
  switch (row.type) {
    case 'text': return s || undefined
    case 'text-multi': return s || undefined
    case 'list': return s ? s.split(/[、，,;；\n]/).map(x => x.trim()).filter(Boolean) : undefined
    case 'number': return s === '' ? undefined : (Number.isNaN(Number(s)) ? s : Number(s))
    case 'boolean': return s === '是'
    case 'object': {
      try {
        return row.text.trim() ? JSON.parse(row.text) : undefined
      } catch {
        return undefined
      }
    }
    case 'tags': return row.tags.length ? row.tags.map(t => t.trim()).filter(Boolean) : undefined
  }
}

/** 注册语义行缓冲 → 值(空/「未知」 → 空,由 commit 决定是否清除) */
function descValueOf(row: AttrRow): string | string[] | undefined {
  if (row.type === 'tags') {
    const tags = row.tags.map(t => t.trim()).filter(t => t && t !== '未知')
    return tags.length ? tags : undefined
  }
  const s = row.text.trim()
  return s && s !== '未知' ? s : undefined
}

/** 把行列表写回 sel(以行为准:删除行 = 清除该属性);每次输入即调用 */
function commitAttr() {
  const c = sel.value
  if (!c) return
  const card = c as unknown as Record<string, unknown>
  for (const f of DESC_FIELDS) {
    const row = attrRows.value.find(r => r.scope === 'desc' && r.key === f.cn)
    if (f.type === 'tags') {
      // personality 等类型要求数组,空数组等同未填
      card[f.prop] = row ? descValueOf(row) ?? [] : []
    } else {
      card[f.prop] = row ? descValueOf(row) : undefined
    }
  }
  const p: Record<string, unknown> = {}
  for (const row of attrRows.value) {
    if (row.scope !== 'free') continue
    const k = row.key.trim()
    const v = freeValueOf(row)
    if (k && v !== undefined) p[k] = v
  }
  card.profile = Object.keys(p).length ? p : undefined
}

// ---- 属性编辑模态框(统一"添加已知字段/自定义键/修改已有属性",不再行内直改) ----
const editAttrOpen = ref(false)

interface AttrEditState {
  mode: 'add' | 'edit'
  /** 被编辑行在 attrRows 中的下标;add 时为 null */
  rowIndex: number | null
  scope: 'desc' | 'free'
  /** 值的编辑形态:desc 按注册类型,fre 由类型选择决定 */
  type: AttrType
  key: string
  /** 内容缓冲(多行;desc tags 以"每行一项"文本表示) */
  text: string
}
const editAttr = ref<AttrEditState | null>(null)

function openAttrEditor(state: AttrEditState) {
  editAttr.value = { ...state }
  editAttrOpen.value = true
}

/** 添加已知字段:已有同键 → 直接编辑该行;否则按该键开一个待填内容的弹窗 */
function addDescField(i: number) {
  if (!sel.value) return
  const f = DESC_FIELDS[i]
  if (!f) return
  const existing = attrRows.value.findIndex(r => r.scope === 'desc' && r.key === f.cn)
  if (existing >= 0) {
    openEditAttrRow(existing)
    return
  }
  openAttrEditor({ mode: 'add', rowIndex: null, scope: 'desc', type: f.type, key: f.cn, text: '' })
}

/** 已知字段下拉项 */
const knownFieldItems = DESC_FIELDS.map((f, i) => ({ label: f.cn, onSelect: () => addDescField(i) }))

/** 添加自定义键(自由区):空键、文本类型,弹窗内填 属性名 + 内容 */
function addFreeField() {
  if (!sel.value) return
  openAttrEditor({ mode: 'add', rowIndex: null, scope: 'free', type: 'text', key: '', text: '' })
}

/** 编辑已有属性:载入内容缓冲(desc tags 以每行一项文本表示) */
function openEditAttrRow(i: number) {
  const row = attrRows.value[i]
  if (!row) return
  const text = row.type === 'tags' ? (row.tags ?? []).join('\n') : row.text
  openAttrEditor({ mode: 'edit', rowIndex: i, scope: row.scope, type: row.type, key: row.key, text })
}

/** 行内容是否为空(空 → 弹窗保存视为删除该属性) */
function editHasValue(state: AttrEditState, type: AttrType): boolean {
  const s = state.text.trim()
  if (type === 'tags') return s.split(/[\n、，,;；]/).map(t => t.trim()).filter(t => t && t !== '未知').length > 0
  if (type === 'boolean') return s === '是' || s === '否'
  if (type === 'object') {
    if (!s) return false
    try {
      JSON.parse(s)
      return true
    } catch {
      return false
    }
  }
  return !!s
}

/** 弹窗保存:键名必填;与其它行重名拦截;内容为空 → 删除该属性;命中约定键自动归语义行 */
function saveAttrEdit() {
  const e = editAttr.value
  if (!e || !sel.value) return
  const rows = attrRows.value
  const key = e.key.trim()
  if (!key) {
    toast.add({ title: '请填写属性名', color: 'warning' })
    return
  }
  const f = DESC_BY_CN.get(key)
  const scope: 'desc' | 'free' = f ? 'desc' : 'free'
  const type: AttrType = scope === 'desc' ? f!.type : e.type
  const dupIdx = rows.findIndex((r, idx) => idx !== e.rowIndex && r.key === key)
  if (dupIdx >= 0) {
    toast.add({ title: `已存在属性「${key}」`, description: '请换一个键名或直接编辑原属性', color: 'warning' })
    return
  }
  // 约定键的文本内容填「未知」等同空(与落库清洗口径一致,不写入不占行)
  const unknownDrop = scope === 'desc' && type !== 'tags' && (e.text ?? '').trim() === '未知'
  if (!editHasValue(e, type) || unknownDrop) {
    // 清空即删除
    if (e.rowIndex != null) rows.splice(e.rowIndex, 1)
    editAttrOpen.value = false
    editAttr.value = null
    commitAttr()
    toast.add({ title: `已移除属性「${key}」`, color: 'neutral' })
    return
  }
  const content = e.text ?? ''
  const row: AttrRow = type === 'tags'
    ? { scope, key, type: 'tags', text: '', tags: content.split(/[\n、，,;；]/).map(t => t.trim()).filter(t => t && t !== '未知') }
    : { scope, key, type, text: content, tags: [] }
  if (e.rowIndex != null) rows[e.rowIndex] = row
  else rows.push(row)
  editAttrOpen.value = false
  editAttr.value = null
  commitAttr()
}

/** 属性卡片预览文本(tags 以顿号连接;其余原样,空返回空串) */
function attrPreview(row: AttrRow): string {
  if (row.type === 'tags') return (row.tags ?? []).join('、')
  return row.text ?? ''
}

/** 弹窗内容占位提示(desc 走注册表,free 按类型兜底) */
function modalPlaceholder(scope: 'desc' | 'free', key: string, type: AttrType): string {
  if (scope === 'desc') return DESC_PLACEHOLDER[key] ?? '内容'
  switch (type) {
    case 'list': return '多项用 顿号/逗号/换行 分隔'
    case 'number': return '数字'
    case 'boolean': return '是 / 否'
    case 'object': return 'JSON 对象'
    default: return '内容…'
  }
}

/** 编辑弹窗内的「删除」:仅编辑已有行时可用(desc → 清除属性;free → 从 profile 摘除) */
function deleteAttrFromModal() {
  const e = editAttr.value
  if (!e || e.rowIndex == null) return
  attrRows.value.splice(e.rowIndex, 1)
  editAttrOpen.value = false
  editAttr.value = null
  commitAttr()
  toast.add({ title: `已移除属性「${e.key.trim()}」`, color: 'neutral' })
}

/** 注册字段的输入占位提示 */
const DESC_PLACEHOLDER: Record<string, string> = {
  别名: '如 学习委员(多个用；分隔)',
  性别: '如 男 / 女',
  年龄: '如 约40岁',
  身份: '如 警察、天文学家',
  首次出场: '如 第3章',
  外貌: '外貌特征…',
  性格: '如 冷静、毒舌(每行一项或顿号分隔)',
  说话风格: '如 低沉、爱用比喻(每行一项或顿号分隔)',
  背景: '人物过往经历…',
  能力: '每行一项,如 剑术',
  目标: '每行一项,如 复仇',
  恐惧: '每行一项,如 黑暗',
  秘密: '每行一项,如 身世之谜'
}

// ---- 分段剧情 / 状态(仅 book2 段角色文件:segments/NNN/角色.json 的 剧情/状态 聚合编辑) ----
interface SegStateRow { key: string, value: string, kind: 'text' | 'number' | 'boolean' | 'object' }
/** 弧线单拍编辑缓冲(segIndex=段下标;与 CharacterArcBeat 对应,存回时转换) */
interface ArcBeatDraft { segIndex: number, summary: string, status: string }
/** 当前角色弧线编辑缓冲 */
interface ArcDraft { summary: string, ending: string, beats: ArcBeatDraft[] }
interface SegDraft {
  /** segments 目录键,如 '000' */
  segKey: string
  index: number
  title: string
  /** 该角色是否在本段出场名单(即使无文件也可填内容创建) */
  inCast: boolean
  plot: string
  stateRows: SegStateRow[]
  /** 本段弧线单拍编辑缓冲(引用 arcDraft.beats 内的同一对象;无则显示「添加本段故事线」) */
  arcBeat?: ArcBeatDraft
}
const segDrafts = ref<SegDraft[]>([])
/** 展开中的折叠栏(按 角色名::段key 记,切换角色不串台) */
const expandedSegs = ref(new Set<string>())

/** 当前角色的弧线编辑草稿(从工作副本拷贝;null=该角色无弧线,可经分段面板添加创建) */
const arcDraft = ref<ArcDraft | null>(null)

/** 从工作副本当前角色的弧线重建编辑草稿(须先于 rebuildSegDrafts 调用) */
function rebuildArcDraft() {
  const a = selArc.value
  arcDraft.value = a
    ? { summary: a.summary ?? '', ending: a.ending ?? '', beats: a.beats.map(b => ({ segIndex: b.beatIndex, summary: b.summary, status: b.status ?? '' })) }
    : null
}

/** 草稿写回工作副本(每次输入即提交,切角色/保存不丢;概述/结局/所有单拍全空 = 移除该角色弧线) */
function commitArcDraft() {
  if (!arcDraft.value || !sel.value) return
  const key = arcKey(sel.value.name)
  const beats = arcDraft.value.beats
    .filter(b => b.summary.trim() || b.status.trim())
    .map(b => ({ beatIndex: b.segIndex, summary: b.summary.trim(), status: b.status.trim() || null }))
  const summary = arcDraft.value.summary.trim()
  const ending = arcDraft.value.ending.trim()
  const rest = characterArcs.value.filter(a => arcKey(a.character) !== key)
  characterArcs.value = !summary && !ending && !beats.length
    ? rest
    : [...rest, { character: sel.value.name, summary, beats, ending }]
}

/** 无弧线角色在分段面板添加本段故事线(创建草稿单拍并挂到段上) */
function addSegArcBeat(d: SegDraft) {
  if (!arcDraft.value) arcDraft.value = { summary: '', ending: '', beats: [] }
  if (!arcDraft.value.beats.some(b => b.segIndex === d.index)) {
    arcDraft.value.beats.push({ segIndex: d.index, summary: '', status: '' })
  }
  d.arcBeat = arcDraft.value.beats.find(b => b.segIndex === d.index)
  commitArcDraft()
}

/** 状态原值 → 编辑缓冲(保类型,存回时按 kind 还原) */
function segValText(v: unknown): { kind: SegStateRow['kind'], text: string } {
  if (typeof v === 'number') return { kind: 'number', text: String(v) }
  if (typeof v === 'boolean') return { kind: 'boolean', text: v ? '是' : '否' }
  if (v && typeof v === 'object') {
    try {
      return { kind: 'object', text: JSON.stringify(v) }
    } catch {
      return { kind: 'text', text: String(v) }
    }
  }
  return { kind: 'text', text: v == null ? '' : String(v) }
}

/** 编辑缓冲 → 状态值(空 → null 剔除;解析失败回退文本,引擎对段状态值本身类型容忍) */
function segValFrom(row: SegStateRow): string | number | boolean | Record<string, unknown> | null {
  const s = row.value.trim()
  if (!s) return null
  switch (row.kind) {
    case 'number': {
      const n = Number(s)
      return Number.isFinite(n) ? n : s
    }
    case 'boolean': {
      if (s === '是') return true
      if (s === '否') return false
      return s
    }
    case 'object': {
      try {
        return JSON.parse(s) as Record<string, unknown>
      } catch {
        return s
      }
    }
    default: return s
  }
}

function rebuildSegDrafts() {
  segDrafts.value = []
  const c = sel.value
  const doc = segDocWork.value
  if (!c || !doc) return
  const name = c.name
  const drafts: SegDraft[] = []
  const segEntries = Object.entries(doc.segments).sort((a, b) => a[1].canon.index - b[1].canon.index)
  for (const [segKey, seg] of segEntries) {
    const cast = seg.canon.cast ?? []
    const file = seg.characters[name]
    if (!file && !cast.includes(name)) continue
    const plot = typeof file?.['剧情'] === 'string' ? file['剧情'] : ''
    const status = file?.['状态'] && typeof file['状态'] === 'object' && !Array.isArray(file['状态'])
      ? file['状态'] as Record<string, unknown>
      : undefined
    const stateRows: SegStateRow[] = []
    if (status) {
      for (const [k, v] of Object.entries(status)) {
        const t = segValText(v)
        stateRows.push({ key: k, value: t.text, kind: t.kind })
      }
    }
    drafts.push({
      segKey,
      index: seg.canon.index,
      title: seg.canon.title?.trim() || `第${seg.canon.index + 1}段`,
      inCast: cast.includes(name),
      plot,
      stateRows,
      arcBeat: arcDraft.value?.beats.find(b => b.segIndex === seg.canon.index)
    })
  }
  segDrafts.value = drafts
}

function segExpKey(d: SegDraft): string {
  return `${sel.value?.name ?? ''}::${d.segKey}`
}

function toggleSeg(d: SegDraft) {
  const k = segExpKey(d)
  const next = new Set(expandedSegs.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  expandedSegs.value = next
}

function segExpanded(d: SegDraft): boolean {
  return expandedSegs.value.has(segExpKey(d))
}

/** 该折叠栏是否有实际内容(剧情或状态行) */
function segHasContent(d: SegDraft): boolean {
  return !!d.plot.trim() || d.stateRows.some(r => r.key.trim() && r.value.trim())
}

/** 以草稿重建该段角色文件并写回 segDocWork(剧情与状态皆空 → 删除文件,与生成管线口径一致) */
function commitSegDraft(d: SegDraft) {
  const doc = segDocWork.value
  const c = sel.value
  if (!doc || !c) return
  const seg = doc.segments[d.segKey]
  if (!seg) return
  const name = c.name
  const status: Record<string, unknown> = {}
  for (const row of d.stateRows) {
    const k = row.key.trim()
    const v = segValFrom(row)
    if (k && v != null) status[k] = v
  }
  const plot = d.plot.trim()
  if (plot || Object.keys(status).length) {
    const file: Record<string, unknown> = { 姓名: name }
    if (plot) file['剧情'] = plot
    if (Object.keys(status).length) file['状态'] = status
    seg.characters[name] = file as never
  } else {
    Reflect.deleteProperty(seg.characters, name)
  }
}

/** 折叠栏内新增/删除一条状态行(键/值输入由 v-model 触发 commit) */
function addSegStateRow(d: SegDraft) {
  d.stateRows.push({ key: '', value: '', kind: 'text' })
}

function removeSegStateRow(d: SegDraft, i: number) {
  d.stateRows.splice(i, 1)
  commitSegDraft(d)
}

/** 两段角色文件是否等价(null 视为同一) */
function sameSegFile(a: unknown, b: unknown): boolean {
  const na = a == null ? undefined : a
  const nb = b == null ? undefined : b
  if (!na && !nb) return true
  return JSON.stringify(na ?? null) === JSON.stringify(nb ?? null)
}

/** 保存时把 segDocWork 中相对最新 book2 数据有差异的 (段,角色) 文件写回/删除,避免覆盖打开期间的并发改动 */
async function flushSegEdits(): Promise<void> {
  const doc = segDocWork.value
  if (!doc) return
  await updateBook2(props.workId, (live) => {
    let changed = false
    const segKeys = new Set([...Object.keys(live.segments), ...Object.keys(doc.segments)])
    for (const key of segKeys) {
      const liveSeg = live.segments[key]
      const workSeg = doc.segments[key]
      if (!liveSeg || !workSeg) continue
      const names = new Set([...Object.keys(liveSeg.characters), ...Object.keys(workSeg.characters)])
      for (const name of names) {
        const lf = liveSeg.characters[name]
        const wf = workSeg.characters[name]
        if (sameSegFile(lf, wf)) continue
        if (!wf || Object.keys(wf).length <= 1) {
          // 只有姓名键(空档):移除该段文件
          Reflect.deleteProperty(liveSeg.characters, name)
        } else {
          liveSeg.characters[name] = JSON.parse(JSON.stringify(wf)) as never
        }
        changed = true
      }
    }
    return changed
  })
}

const patienceModel = computed({
  get: () => sel.value?.patience == null ? '' : String(sel.value.patience),
  set: (v: string) => { if (sel.value) sel.value.patience = numOrNull(v) }
})

const softnessModel = computed({
  get: () => sel.value?.softness == null ? '' : String(sel.value.softness),
  set: (v: string) => { if (sel.value) sel.value.softness = numOrNull(v) }
})

const desireModel = computed({
  get: () => sel.value?.desire == null ? '' : String(sel.value.desire),
  set: (v: string) => { if (sel.value) sel.value.desire = numOrNull(v) }
})

/** 性压抑档位说明(输入框 description:空值时给五档总览,有值时给当前档位) */
const desireDesc = computed(() => {
  const v = sel.value?.desire
  if (v == null) return '0-100 分五档:懵懂无知/腼腆娇羞/情动意乱/欲念难抑/兽欲大发;低指数=性冷淡,欲望波动小、难被挑起'
  const tier = desireTierName(v)
  const desc = DESIRE_TIERS.find(t => t.label === tier)?.desc ?? ''
  return tier ? `${tier}:${desc}` : '0-100'
})

// ---- 保存 ----
function normalizeCards(): CharacterCard[] {
  return draft.value.map((c) => {
    const name = (c.name ?? '').trim()
    const patch: CharacterCard = {
      name,
      role: (c.role ?? '').trim() || '配角',
      personality: []
    }
    for (const k of ['alias', 'gender', 'age', 'identity', 'appearance', 'background', 'first_appearance'] as const) {
      const v = (c[k] ?? '').toString().trim()
      if (v) patch[k] = v
    }
    for (const k of ['personality', 'speech_style', 'abilities', 'goals', 'fears', 'secrets'] as const) {
      const arr = (c[k] ?? []).map(v => String(v).trim()).filter(Boolean)
      if (arr.length) patch[k] = arr
    }
    const rels = (c.relationships ?? [])
      .filter(r => (r.name ?? '').trim())
      .map(r => ({ name: r.name.trim(), type: (r.type ?? '').trim() || '未知', value: relNum(r.value) }))
    if (rels.length) patch.relationships = rels
    if (c.patience != null) patch.patience = numOrNull(c.patience)
    if (c.softness != null) patch.softness = numOrNull(c.softness)
    if (c.desire != null) patch.desire = numOrNull(c.desire)
    const kinks = (c.kinks ?? [])
      .filter(k => (k.theme ?? '').trim())
      .map(k => ({ theme: k.theme.trim(), view: k.view ?? null, role: k.role ?? null, detail: k.detail ?? null }))
    if (kinks.length) patch.kinks = kinks
    const sex: Partial<SexAttrs> = {}
    for (const k of SEX_TEXT_KEYS) {
      const v = c.sex?.[k]
      if (v && v.trim()) sex[k] = v.trim()
    }
    if (c.sex?.condom === true || c.sex?.condom === false) sex.condom = c.sex.condom
    if (Object.keys(sex).length) patch.sex = sex
    // 章节变体不进编辑表单(生成流水线产物),保存时原样保留,避免被丢弃
    if ((c.chapterVariants ?? []).length) patch.chapterVariants = c.chapterVariants
    // v2 自由区(profile):不进表单的可编辑已知字段,保存时透传,避免被丢弃
    if (c.profile && Object.keys(c.profile).length) patch.profile = c.profile
    return patch
  })
}

async function onSave() {
  const cards = normalizeCards()
  const names = cards.map(c => c.name)
  if (names.some(n => !n)) {
    toast.add({ title: '保存失败', description: '有角色名称为空,请先补全', color: 'error' })
    return
  }
  if (new Set(names).size !== names.length) {
    toast.add({ title: '保存失败', description: '存在重名的角色,请先改名', color: 'error' })
    return
  }
  saving.value = true
  try {
    // 弧线草稿可能有最后一次输入未落副本,先统一提交
    commitArcDraft()
    // 重新读取最新数据,避免覆盖弹窗打开期间的其它改动(如游玩累计 tokens)
    const view = await loadWorkView(props.workId)
    if (!view) throw new Error('本地未找到该作品')
    if (view.source === 'book2') {
      // v2 真源在 book2 zip:人物卡写回 characters/ 基础层
      await saveBook2Characters(props.workId, cards)
      // 分段剧情 / 状态:把弹窗内改动的段角色文件按差异合并回段数据
      await flushSegEdits()
      // 独立故事线:整层写回 world(保留实体库/冲突,只替换 characterArcs)。
      // reactive 代理进不了 IndexedDB(structured clone 抛 DataCloneError),先深拷为普通对象
      await updateBook2World(props.workId, {
        ...view.world,
        characterArcs: JSON.parse(JSON.stringify(characterArcs.value)) as CharacterArc[]
      })
    } else {
      const work = await getWork(props.workId)
      if (!work) throw new Error('本地未找到该作品')
      await saveWork({
        ...work,
        overlay: { ...work.overlay, characters: cards },
        // 同弧线写回:reactive 代理深拷为普通对象再落库
        characterArcs: JSON.parse(JSON.stringify(characterArcs.value)) as CharacterArc[],
        // 云端已有对应作品时标记待同步,书架卡片会显示「待同步」徽章
        syncStatus: work.syncStatus === 'synced' ? 'dirty' : work.syncStatus,
        updatedAt: new Date().toISOString()
      })
    }
    await clearOverlappingPatches(view.characters, cards)
    emit('saved')
    open.value = false
  } catch (e) {
    toast.add({ title: '保存失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

/** 卡片可被局内 AI 补丁覆盖的人物卡字段(与 CharacterDynamicState.patch 允许的键对应) */
const PATCHABLE_KEYS = [
  'alias', 'gender', 'age', 'identity', 'appearance', 'background', 'first_appearance',
  'personality', 'speech_style', 'abilities', 'goals', 'fears', 'secrets', 'relationships',
  'dead', 'patience', 'softness', 'desire', 'kinks', 'sex'
] as const

/** 编辑保存后,清除进行中游戏里该角色动态补丁中与本次被编辑字段重叠的键:
 *  有效卡=基础卡+局内补丁,不清理的话用户改的卡字段会被 AI 玩出来的旧补丁一直覆盖 */
async function clearOverlappingPatches(prevCards: CharacterCard[], cards: CharacterCard[]) {
  const editedFields = new Map<string, Set<string>>()
  for (const c of cards) {
    const prev = prevCards.find(p => p.name === c.name)
    if (!prev) continue
    const fields = new Set<string>()
    for (const k of PATCHABLE_KEYS) {
      if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(c[k] ?? null)) fields.add(k)
    }
    if (fields.size) editedFields.set(c.name, fields)
  }
  if (!editedFields.size) return
  const games = await listLocalGames()
  let touched = 0
  for (const g of games) {
    if (g.workId !== props.workId) continue
    const states = g.state?.characterStates
    if (!states) continue
    let dirty = false
    for (const [name, fields] of editedFields) {
      const patch = states[name]?.patch
      if (!patch || !Object.keys(patch).length) continue
      // 重建补丁对象只保留未重叠键(避免动态 delete)
      const kept: Partial<NonNullable<typeof patch>> = {}
      let removed = false
      for (const [k, v] of Object.entries(patch)) {
        if (fields.has(k)) {
          removed = true
          continue
        }
        ;(kept as Record<string, unknown>)[k] = v
      }
      if (removed) {
        states[name]!.patch = kept
        dirty = true
      }
    }
    if (dirty) {
      await saveLocalGame(g)
      touched++
    }
  }
  if (touched) {
    toast.add({ title: '已同步清理游戏状态', description: `${touched} 局游戏中该角色的相关动态变化已按新卡重置`, color: 'neutral' })
  }
}

// ---- 删除角色确认(误删后点保存即不可逆) ----
const removeConfirmOpen = ref(false)

function askRemoveCard() {
  removeConfirmOpen.value = true
}

function confirmRemoveCard() {
  removeConfirmOpen.value = false
  removeCard(selIdx.value)
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="编辑角色卡"
    :description="`《${workTitle || '未命名作品'}》 · 共 ${draft.length} 张角色卡`"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <div
        v-if="!loaded"
        class="flex items-center justify-center gap-2 py-12 text-sm text-neutral-500"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin"
        />
        正在加载角色卡…
      </div>

      <UAlert
        v-else-if="loadErr"
        color="error"
        variant="soft"
        :title="loadErr"
      />

      <template v-else>
        <div class="flex flex-col gap-4 sm:flex-row">
          <!-- 角色列表:移动端横向滚动,桌面端左侧列表 -->
          <div class="flex shrink-0 gap-1.5 overflow-x-auto pb-1 sm:w-48 sm:flex-col sm:overflow-y-auto sm:pb-0 sm:pr-1 sm:max-h-[60vh]">
            <button
              v-for="i in orderedCardIndexes"
              :key="i"
              type="button"
              class="flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-sm transition"
              :class="i === selIdx
                ? 'border-primary-500/60 bg-primary-500/10 text-primary-600 dark:text-primary-400'
                : 'border-(--ui-border) text-(--ui-text) hover:border-primary-400/50'"
              @click="selIdx = i"
            >
              <span class="max-w-24 truncate">{{ draft[i]?.name || '未命名' }}</span>
              <span
                class="shrink-0 rounded-full px-1.5 text-[10px]"
                :class="draft[i]?.role === '主角' ? 'bg-primary-500/15 text-primary-600 dark:text-primary-400' : draft[i]?.role === '反派' ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-neutral-500/10 text-neutral-500'"
              >
                {{ draft[i]?.role || '配角' }}
              </span>
              <span
                v-if="arcOfCard(draft[i]?.name)"
                class="shrink-0 text-[10px] text-primary-600 dark:text-primary-400"
                title="有独立故事线"
              >线</span>
            </button>
            <UButton
              block
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-plus"
              label="添加角色"
              class="shrink-0 sm:mt-1"
              @click="addCard"
            />
          </div>

          <!-- 角色卡表单 -->
          <div
            v-if="sel"
            class="min-w-0 flex-1 space-y-5 sm:max-h-[60vh] sm:overflow-y-auto sm:pr-1"
          >
            <!-- 基本信息:姓名/角色 为结构化锚点,固定显示;其余描述属性走下方「属性(键:值)」 -->
            <section class="space-y-3">
              <h4 class="flex items-center justify-between text-xs font-semibold text-neutral-500">
                基本信息
                <UButton
                  label="删除此角色"
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="subtle"
                  size="xs"
                  @click="askRemoveCard"
                />
              </h4>
              <div class="grid grid-cols-2 gap-3">
                <UFormField
                  label="姓名"
                  class="col-span-2 sm:col-span-1"
                >
                  <UInput
                    v-model="sel.name"
                    placeholder="角色名称"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="角色定位">
                  <USelectMenu
                    v-model="roleSel"
                    :items="withCurrent(sel.role, ['主角', '配角', '反派'])"
                    :search-input="false"
                    class="w-full"
                  />
                </UFormField>
              </div>
              <p
                v-if="workSource === 'book2'"
                class="text-xs text-neutral-400"
              >
                生死、身份转变等随剧情发展的状态不在基础卡固定填写:请在下方「分段剧情 / 状态」定位到发生变化的段落,用状态键表达(如 已死亡 = 是)。
              </p>
            </section>

            <!-- 属性(键:值):描述属性自由化——保留中文键语义,任意新键进自由区 -->
            <section class="space-y-2">
              <div class="flex items-center justify-between">
                <h4 class="text-xs font-semibold text-neutral-500">
                  属性(键:值)
                </h4>
                <div class="flex items-center gap-1">
                  <UDropdownMenu
                    :items="knownFieldItems"
                    :content="{ align: 'end' }"
                  >
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="soft"
                      icon="i-lucide-list-plus"
                    >
                      添加已知字段
                    </UButton>
                  </UDropdownMenu>
                  <UButton
                    size="xs"
                    color="primary"
                    variant="soft"
                    icon="i-lucide-plus"
                    @click="addFreeField"
                  >
                    自定义键
                  </UButton>
                </div>
              </div>
              <p class="text-xs text-neutral-400">
                属性以「中文键 + 内容」保存;键名命中 性别/外貌/性格… 等约定键时按引擎语义参与演绎,其余自定义键作为「补充设定」交给 AI。修改与删除都点标题行右侧「编辑」,在弹窗中操作。
              </p>
              <div
                v-if="!attrRows.length"
                class="rounded-lg border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-400 dark:border-neutral-700"
              >
                还没有属性,点右上角「添加已知字段」或「自定义键」添加
              </div>
              <div
                v-for="(row, i) in attrRows"
                :key="i"
                class="flex items-start justify-between gap-3"
              >
                <div class="min-w-0 flex-1">
                  <p
                    v-if="row.scope === 'desc'"
                    class="text-xs font-semibold text-primary-600 dark:text-primary-400"
                    title="约定键:按引擎语义参与演绎"
                  >
                    {{ row.key }}
                  </p>
                  <p
                    v-else
                    class="text-xs font-semibold text-neutral-500 dark:text-neutral-400"
                    title="自定义键:作为「补充设定」交给 AI"
                  >
                    {{ row.key }}
                  </p>
                  <p
                    v-if="attrPreview(row)"
                    class="mt-0.5 break-words whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300"
                  >
                    {{ attrPreview(row) }}
                  </p>
                  <p
                    v-else
                    class="mt-0.5 text-xs text-neutral-400"
                  >
                    未填写内容,点标题行右侧「编辑」填写
                  </p>
                </div>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-pencil"
                  aria-label="编辑属性"
                  class="-mt-0.5 shrink-0"
                  @click="openEditAttrRow(i)"
                />
              </div>
            </section>

            <!-- 独立故事线(world 层弧线,弹窗内可编辑;扮演该角色时作为主叙事线) -->
            <section
              v-if="arcDraft && selArc"
              class="space-y-3"
            >
              <h4 class="text-xs font-semibold text-neutral-500">
                独立故事线
                <span class="ml-1 font-normal">{{ arcDraft.beats.length }} 段戏份</span>
              </h4>
              <UFormField label="弧线概述">
                <UTextarea
                  v-model="arcDraft.summary"
                  :rows="2"
                  placeholder="该角色全书的弧线概述(目标 / 宿命 / 处境演变)…"
                  class="w-full"
                  @update:model-value="commitArcDraft()"
                />
              </UFormField>
              <ul
                v-if="arcDraft.beats.length"
                class="max-h-56 space-y-1.5 overflow-y-auto text-xs text-neutral-600 dark:text-neutral-400"
              >
                <li
                  v-for="b in arcDraft.beats"
                  :key="b.segIndex"
                >
                  <span class="font-medium text-highlighted">段{{ b.segIndex + 1 }}</span>
                  {{ b.summary }}<template v-if="b.status">
                    ({{ b.status }})
                  </template>
                </li>
              </ul>
              <UFormField label="结局走向">
                <UInput
                  v-model="arcDraft.ending"
                  placeholder="该角色在全书终局的状态,可空"
                  class="w-full"
                  @update:model-value="commitArcDraft()"
                />
              </UFormField>
              <p class="text-xs text-neutral-400">
                扮演该角色时以此为主叙事线;各段戏份在下方「分段剧情 / 状态」里按段编辑。重跑「质量提升补充生成」并「更新世界情报」会覆盖手改内容。
              </p>
            </section>

            <!-- 分段剧情 / 状态(book2 段角色文件聚合编辑;每段一个折叠栏,存回段文件) -->
            <section
              v-if="workSource === 'book2' && segDrafts.length"
              class="space-y-2"
            >
              <h4 class="text-xs font-semibold text-neutral-500">
                分段剧情 / 状态
                <span class="ml-1 font-normal">{{ segDrafts.length }} 段</span>
              </h4>
              <p class="text-xs text-neutral-400">
                每段三块:「独立故事线」存 world 层弧线(仅扮演该角色时生效,重跑质量提升生成会覆盖;留空保存即删除该单拍);「本段剧情」与「属性状态」存于段文件,进入该段时生效,属性状态命中 身份/外貌/性格/背景/目标/别名/性欲强度/耐心/心软/已死亡 键会临时覆盖基础卡,其它键作本段补充设定。剧情/状态留空即清除。
              </p>
              <div
                v-for="d in segDrafts"
                :key="d.segKey"
                class="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700"
              >
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  @click="toggleSeg(d)"
                >
                  <UIcon
                    name="i-lucide-chevron-right"
                    class="size-4 shrink-0 transition-transform"
                    :class="segExpanded(d) ? 'rotate-90' : ''"
                  />
                  <span class="min-w-0 flex-1 truncate">
                    <span class="font-medium text-highlighted">段{{ d.index + 1 }}</span>
                    <span class="text-neutral-600 dark:text-neutral-300"> · {{ d.title }}</span>
                  </span>
                  <span
                    v-if="segHasContent(d)"
                    class="shrink-0 rounded-full bg-primary-500/10 px-1.5 py-0.5 text-[10px] text-primary-600 dark:bg-primary-400/10 dark:text-primary-400"
                  >有内容</span>
                  <span
                    v-else
                    class="shrink-0 text-[10px] text-neutral-400"
                  >空</span>
                </button>
                <div
                  v-if="segExpanded(d)"
                  class="space-y-2.5 border-t border-neutral-200 px-3 py-2.5 dark:border-neutral-700"
                >
                  <!-- 本段独立故事线:world 层弧线的本段单拍,可编辑保存;扮演该角色时生效;不落段文件 -->
                  <div
                    v-if="d.arcBeat"
                    class="space-y-1.5 rounded-md bg-primary-500/5 px-2.5 py-2 dark:bg-primary-400/5"
                  >
                    <p class="flex items-center gap-1 text-xs font-medium text-primary-600 dark:text-primary-400">
                      <UIcon
                        name="i-lucide-route"
                        class="size-3.5 shrink-0"
                      />
                      本段独立故事线(扮演生效)
                    </p>
                    <UTextarea
                      v-model="d.arcBeat.summary"
                      :rows="2"
                      placeholder="该角色在本段的行动 / 处境 / 目标推进…"
                      class="w-full"
                      @update:model-value="commitArcDraft()"
                    />
                    <UInput
                      v-model="d.arcBeat.status"
                      size="xs"
                      placeholder="本段处境变化(如 受伤/身份转变),可空"
                      class="w-full"
                      @update:model-value="commitArcDraft()"
                    />
                  </div>
                  <UButton
                    v-else
                    label="添加本段故事线"
                    icon="i-lucide-route"
                    color="neutral"
                    variant="soft"
                    size="xs"
                    class="self-start"
                    @click="addSegArcBeat(d)"
                  />
                  <UFormField label="本段剧情">
                    <UTextarea
                      v-model="d.plot"
                      :rows="2"
                      placeholder="该角色在本段的行动 / 处境 / 目标推进…"
                      class="w-full"
                      @update:model-value="commitSegDraft(d)"
                    />
                  </UFormField>
                  <div class="space-y-1.5">
                    <p class="text-xs font-medium text-neutral-500">
                      属性状态
                    </p>
                    <div
                      v-for="(row, i) in d.stateRows"
                      :key="i"
                      class="flex items-center gap-2"
                    >
                      <UInput
                        v-model="row.key"
                        size="xs"
                        placeholder="键(如 处境/外貌/已死亡)"
                        class="w-36 shrink-0"
                        @update:model-value="commitSegDraft(d)"
                      />
                      <UInput
                        v-model="row.value"
                        size="xs"
                        placeholder="值(清空键名即移除该行)"
                        class="min-w-0 flex-1"
                        @update:model-value="commitSegDraft(d)"
                      />
                      <UButton
                        icon="i-lucide-x"
                        color="error"
                        variant="ghost"
                        size="xs"
                        aria-label="删除状态行"
                        @click="removeSegStateRow(d, i)"
                      />
                    </div>
                    <UButton
                      v-if="!d.stateRows.length || d.stateRows[d.stateRows.length - 1].key"
                      label="添加状态"
                      icon="i-lucide-plus"
                      color="neutral"
                      variant="soft"
                      size="xs"
                      @click="addSegStateRow(d)"
                    />
                  </div>
                </div>
              </div>
            </section>

            <!-- 关系与人设数值 -->
            <section class="space-y-3">
              <h4 class="text-xs font-semibold text-neutral-500">
                关系与数值
              </h4>
              <UFormField
                label="人物关系"
                description="亲密度 -100 ~ 100(负值敌对,正值亲近)"
              >
                <div class="space-y-2">
                  <div
                    v-for="(r, i) in sel.relationships ?? []"
                    :key="i"
                    class="flex items-center gap-2"
                  >
                    <UInput
                      v-model="r.name"
                      placeholder="对方姓名"
                      class="w-24 shrink-0"
                    />
                    <UInput
                      v-model="r.type"
                      placeholder="关系,如 青梅竹马"
                      class="min-w-0 flex-1"
                    />
                    <UInput
                      type="number"
                      :model-value="r.value ?? 0"
                      min="-100"
                      max="100"
                      class="w-18 shrink-0"
                      @update:model-value="v => (r.value = relNum(v))"
                    />
                    <UButton
                      icon="i-lucide-x"
                      color="error"
                      variant="ghost"
                      size="xs"
                      aria-label="删除关系"
                      @click="removeRel(i)"
                    />
                  </div>
                  <div
                    v-if="!(sel.relationships ?? []).length"
                    class="text-xs text-neutral-400"
                  >
                    暂无关系,点击下方按钮添加
                  </div>
                  <UButton
                    label="添加关系"
                    icon="i-lucide-plus"
                    color="neutral"
                    variant="soft"
                    size="xs"
                    @click="addRel"
                  />
                </div>
              </UFormField>
              <UFormField
                label="题材喜好(亚文化玩法)"
                description="每个玩法一张卡片;「态度」影响该玩法的演绎倾向,「定位」决定承受/施予方向"
              >
                <div class="space-y-3">
                  <div
                    v-for="(k, i) in sel.kinks ?? []"
                    :key="i"
                    class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
                  >
                    <!-- 卡片头:序号 + 玩法名 + 删除 -->
                    <div class="mb-3 flex items-center gap-2">
                      <UBadge
                        color="neutral"
                        variant="soft"
                        size="sm"
                        class="shrink-0 font-mono"
                      >
                        {{ i + 1 }}
                      </UBadge>
                      <UInput
                        v-model="k.theme"
                        placeholder="玩法名称,如 打屁股"
                        class="min-w-0 flex-1"
                      />
                      <UButton
                        icon="i-lucide-trash-2"
                        color="error"
                        variant="ghost"
                        size="xs"
                        aria-label="删除此玩法"
                        @click="removeKink(i)"
                      />
                    </div>
                    <!-- 卡片体:态度 / 定位 双列 -->
                    <div class="grid grid-cols-2 gap-3">
                      <UFormField
                        label="态度"
                        size="sm"
                        :ui="{ label: 'text-xs' }"
                      >
                        <USelectMenu
                          :model-value="k.view ?? '未知'"
                          :items="KINK_VIEWS"
                          :search-input="false"
                          class="w-full"
                          @update:model-value="v => (k.view = v === '未知' ? null : (v ?? null))"
                        />
                      </UFormField>
                      <UFormField
                        label="定位"
                        size="sm"
                        :ui="{ label: 'text-xs' }"
                      >
                        <USelectMenu
                          :model-value="k.role ?? '未知'"
                          :items="KINK_ROLES"
                          :search-input="false"
                          class="w-full"
                          @update:model-value="v => (k.role = v === '未知' ? null : (v ?? null))"
                        />
                      </UFormField>
                    </div>
                    <UFormField
                      label="细节说明"
                      size="sm"
                      class="mt-2"
                      :ui="{ label: 'text-xs' }"
                    >
                      <UInput
                        :model-value="k.detail ?? ''"
                        placeholder="可选;如 力度偏好/进阶玩法/禁区"
                        class="w-full"
                        @update:model-value="v => (k.detail = v.trim() || null)"
                      />
                    </UFormField>
                  </div>
                  <div
                    v-if="!(sel.kinks ?? []).length"
                    class="rounded-lg border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-400 dark:border-neutral-700"
                  >
                    暂无玩法,点击下方按钮添加
                  </div>
                  <UButton
                    label="添加玩法"
                    icon="i-lucide-plus"
                    color="neutral"
                    variant="soft"
                    size="sm"
                    @click="addKink"
                  />
                </div>
              </UFormField>
              <UFormField
                label="性爱属性"
                description="偏好体位/语言挑逗/尺寸/持久/身材等,按原著设定填写,留空为未知"
              >
                <div class="grid grid-cols-2 gap-3">
                  <UFormField label="偏好体位">
                    <UInput
                      v-model="positionsModel"
                      placeholder="如 后入/骑乘"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="床笫习惯">
                    <UInput
                      v-model="habitsModel"
                      placeholder="习惯/癖好"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="语言挑逗">
                    <UInput
                      v-model="teaseModel"
                      placeholder="如 骚话/闷骚"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="性能力 / 技巧">
                    <UInput
                      v-model="skillModel"
                      placeholder="如 熟练/生涩"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="性器官大小形状">
                    <UInput
                      v-model="memberModel"
                      placeholder="尺寸/形状"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="持久能力">
                    <UInput
                      v-model="staminaModel"
                      placeholder="如 半小时"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="身材曲线">
                    <UInput
                      v-model="figureModel"
                      placeholder="如 前凸后翘"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="手指粗细">
                    <UInput
                      v-model="fingersModel"
                      placeholder="如 修长/粗壮"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="是否戴套">
                    <USelectMenu
                      :model-value="condomModel"
                      :items="CONDOM_OPTS"
                      :search-input="false"
                      class="w-full"
                      @update:model-value="setCondom"
                    />
                  </UFormField>
                </div>
              </UFormField>
              <div class="grid grid-cols-2 gap-3">
                <UFormField
                  label="耐心(0-100)"
                  description="越小越急躁"
                >
                  <UInput
                    v-model="patienceModel"
                    type="number"
                    min="0"
                    max="100"
                    placeholder="未知"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  label="心软(0-100)"
                  description="越大越容易心软"
                >
                  <UInput
                    v-model="softnessModel"
                    type="number"
                    min="0"
                    max="100"
                    placeholder="未知"
                    class="w-full"
                  />
                </UFormField>
              </div>
              <UFormField
                label="性压抑指数(0-100)"
                :description="desireDesc"
              >
                <UInput
                  v-model="desireModel"
                  type="number"
                  min="0"
                  max="100"
                  placeholder="未知"
                  class="w-full"
                />
              </UFormField>
            </section>
          </div>

          <!-- 无角色卡 -->
          <div
            v-else
            class="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 text-center"
          >
            <UIcon
              name="i-lucide-users"
              class="size-8 text-neutral-300"
            />
            <p class="text-sm text-neutral-500">
              还没有角色卡,点击左侧「添加角色」手动创建;<br>
              也可以在生成世界页重新生成,自动提取人物卡
            </p>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <UButton
        label="取消"
        color="neutral"
        variant="outline"
        class="shrink-0"
        @click="open = false"
      />
      <UButton
        label="保存"
        icon="i-lucide-save"
        color="primary"
        class="flex-1"
        :loading="saving"
        @click="onSave"
      />
    </template>
  </UModal>

  <!-- 属性(键:值)编辑弹窗:添加自定义键 / 修改已有属性共用 -->
  <UModal
    v-model:open="editAttrOpen"
    :title="editAttr?.mode === 'edit' ? '编辑属性' : '添加属性'"
    :description="editAttr?.scope === 'desc' ? `「${editAttr.key}」为约定键,按引擎语义参与演绎` : '自定义键会作为「补充设定」交给 AI'"
  >
    <template #body>
      <div
        v-if="editAttr"
        class="space-y-3"
      >
        <UFormField label="属性名">
          <UInput
            v-if="editAttr.scope === 'desc'"
            :model-value="editAttr.key"
            disabled
            class="w-full"
          />
          <UInput
            v-else
            v-model="editAttr.key"
            placeholder="如 家庭背景 / 口头禅(填 性别/外貌/性格… 等约定键会自动归为语义键)"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="editAttr.scope === 'free'"
          label="类型"
        >
          <USelect
            v-model="editAttr.type"
            :items="FREE_TYPES"
            value-key="value"
            label-key="label"
            class="w-full"
          />
        </UFormField>
        <UFormField label="内容">
          <UTextarea
            v-model="editAttr.text"
            autoresize
            :rows="4"
            :placeholder="modalPlaceholder(editAttr.scope, editAttr.key, editAttr.type)"
            class="w-full"
          />
          <p class="mt-1 text-xs text-neutral-400">
            <template v-if="editAttr.type === 'tags'">
              每行一项;也可用 顿号/逗号 分隔后一次输入(多个值以列表保存)
            </template>
            <template v-else>
              留空保存也会移除该属性
            </template>
          </p>
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex items-center justify-between gap-2">
        <UButton
          v-if="editAttr?.rowIndex != null"
          label="删除此属性"
          icon="i-lucide-trash-2"
          color="error"
          variant="soft"
          @click="deleteAttrFromModal"
        />
        <div class="ml-auto flex items-center gap-2">
          <UButton
            label="取消"
            color="neutral"
            variant="outline"
            @click="editAttrOpen = false"
          />
          <UButton
            label="保存"
            icon="i-lucide-check"
            color="primary"
            @click="saveAttrEdit"
          />
        </div>
      </div>
    </template>
  </UModal>

  <!-- 删除角色确认(草稿删除;点「保存」后不可逆) -->
  <UModal
    v-model:open="removeConfirmOpen"
    title="删除角色"
    description="从当前编辑中移除该角色"
  >
    <template #body>
      <p class="text-sm text-neutral-600 dark:text-neutral-300">
        确定删除角色「{{ sel?.name || '未命名' }}」?
        删除后需点击「保存」才会生效;保存后无法恢复。
      </p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          label="取消"
          color="neutral"
          variant="outline"
          @click="removeConfirmOpen = false"
        />
        <UButton
          label="删除"
          icon="i-lucide-trash-2"
          color="error"
          @click="confirmRemoveCard"
        />
      </div>
    </template>
  </UModal>
</template>
