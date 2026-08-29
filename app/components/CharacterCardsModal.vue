<script setup lang="ts">
// 编辑角色卡弹窗:修改/新增/删除本地作品 overlay.characters,保存回 IndexedDB works
// 入口:书架「本地作品」卡片上的「角色卡」按钮;保存后由父组件刷新列表
import { getWork, saveWork } from '../utils/worldGen'
import { desireTierName, DESIRE_TIERS, SEX_TEXT_KEYS } from '#shared/novel'
import type { CharacterCard, SexAttrs, SexTextField } from '#shared/novel'

const props = defineProps<{ workId: string }>()
const emit = defineEmits<{ saved: [] }>()

const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const workTitle = ref('')
const draft = ref<CharacterCard[]>([])
const selIdx = ref(0)
const saving = ref(false)
const loaded = ref(false)
const loadErr = ref('')

const sel = computed(() => draft.value[selIdx.value])

/** 选项不足时把当前值并入候选(避免 AI 生成的非标准值在选择器里丢失) */
function withCurrent(current: string | null | undefined, base: string[]): string[] {
  const v = (current ?? '').trim()
  return v && !base.includes(v) ? [v, ...base] : base
}

const roleSel = computed({
  get: () => sel.value?.role ?? '配角',
  set: (v: string) => { if (sel.value) sel.value.role = v }
})

const genderSel = computed({
  get: () => sel.value?.gender ?? '未知',
  set: (v: string) => { if (sel.value) sel.value.gender = v }
})

watch(open, async (v) => {
  if (!v) return
  saving.value = false
  loaded.value = false
  loadErr.value = ''
  selIdx.value = 0
  const work = await getWork(props.workId)
  if (!work) {
    loadErr.value = '本地未找到该作品'
    loaded.value = true
    return
  }
  workTitle.value = work.title
  draft.value = JSON.parse(JSON.stringify(work.overlay?.characters ?? []))
  loaded.value = true
})

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

/** 可空字符串字段 ↔ 空串(模板 v-model 用,避免 null 与输入框类型冲突) */
type StrKey = 'alias' | 'age' | 'identity' | 'appearance' | 'background' | 'first_appearance'
function strField(key: StrKey) {
  return computed({
    // 旧数据 age 可能是数字,统一转字符串再绑定输入框
    get: () => (sel.value?.[key] == null ? '' : String(sel.value[key])),
    set: (v: string) => { if (sel.value) sel.value[key] = v }
  })
}

const aliasModel = strField('alias')
const ageModel = strField('age')
const identityModel = strField('identity')
const appearanceModel = strField('appearance')
const backgroundModel = strField('background')
const firstAppearanceModel = strField('first_appearance')

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

/** 性欲档位说明(输入框 description:空值时给五档总览,有值时给当前档位) */
const desireDesc = computed(() => {
  const v = sel.value?.desire
  if (v == null) return '0-100 分五档:懵懂无知/腼腆娇羞/情动意乱/欲念难抑/兽欲大发;低强度=性冷淡,欲望波动小、难被挑起'
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
    if (c.dead) patch.dead = true
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
    // 重新读取最新数据,避免覆盖弹窗打开期间的其它改动(如游玩累计 tokens)
    const work = await getWork(props.workId)
    if (!work) throw new Error('本地未找到该作品')
    await saveWork({
      ...work,
      overlay: { ...work.overlay, title: work.overlay?.title, genre: work.overlay?.genre, summary: work.overlay?.summary, characters: cards },
      updatedAt: new Date().toISOString()
    })
    emit('saved')
    open.value = false
  } catch (e) {
    toast.add({ title: '保存失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    saving.value = false
  }
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
              v-for="(c, i) in draft"
              :key="i"
              type="button"
              class="flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-sm transition"
              :class="i === selIdx
                ? 'border-primary-500/60 bg-primary-500/10 text-primary-600 dark:text-primary-400'
                : 'border-(--ui-border) text-(--ui-text) hover:border-primary-400/50'"
              @click="selIdx = i"
            >
              <span class="max-w-24 truncate">{{ c.name || '未命名' }}</span>
              <span
                class="shrink-0 rounded-full px-1.5 text-[10px]"
                :class="c.role === '主角' ? 'bg-primary-500/15 text-primary-600 dark:text-primary-400' : c.role === '反派' ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-neutral-500/10 text-neutral-500'"
              >
                {{ c.role || '配角' }}
              </span>
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
            <!-- 基本信息 -->
            <section class="space-y-3">
              <h4 class="flex items-center justify-between text-xs font-semibold text-neutral-500">
                基本信息
                <UButton
                  label="删除此角色"
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="subtle"
                  size="xs"
                  @click="removeCard(selIdx)"
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
                <UFormField label="性别">
                  <USelectMenu
                    v-model="genderSel"
                    :items="withCurrent(sel.gender, ['男', '女', '未知'])"
                    :search-input="false"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="别名">
                  <UInput
                    v-model="aliasModel"
                    placeholder="别名 / 称呼"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="年龄">
                  <UInput
                    v-model="ageModel"
                    placeholder="如 约40岁 / 未知"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="身份 / 职业">
                  <UInput
                    v-model="identityModel"
                    placeholder="如 警察、天文学家"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="首次出场">
                  <UInput
                    v-model="firstAppearanceModel"
                    placeholder="如 第3章"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  label="状态"
                  class="col-span-2 sm:col-span-1"
                >
                  <div class="flex h-9 items-center">
                    <UCheckbox
                      v-model="sel.dead"
                      label="该角色已死亡"
                    />
                  </div>
                </UFormField>
              </div>
            </section>

            <!-- 形象与性格 -->
            <section class="space-y-3">
              <h4 class="text-xs font-semibold text-neutral-500">
                形象与性格
              </h4>
              <UFormField label="外貌描写">
                <UTextarea
                  v-model="appearanceModel"
                  :rows="2"
                  placeholder="外貌特征…"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="性格特征">
                <TagListInput
                  v-model="sel.personality"
                  placeholder="回车添加,如 冷静、毒舌"
                />
              </UFormField>
              <UFormField label="说话风格">
                <TagListInput
                  v-model="sel.speech_style"
                  placeholder="回车添加,如 低沉、爱用比喻"
                />
              </UFormField>
            </section>

            <!-- 背景与动机 -->
            <section class="space-y-3">
              <h4 class="text-xs font-semibold text-neutral-500">
                背景与动机
              </h4>
              <UFormField label="背景故事">
                <UTextarea
                  v-model="backgroundModel"
                  :rows="3"
                  placeholder="人物过往经历…"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="能力 / 特殊技能">
                <TagListInput
                  v-model="sel.abilities"
                  placeholder="回车添加"
                />
              </UFormField>
              <UFormField label="目标 / 动机">
                <TagListInput
                  v-model="sel.goals"
                  placeholder="回车添加"
                />
              </UFormField>
              <UFormField label="恐惧 / 弱点">
                <TagListInput
                  v-model="sel.fears"
                  placeholder="回车添加"
                />
              </UFormField>
              <UFormField label="秘密">
                <TagListInput
                  v-model="sel.secrets"
                  placeholder="回车添加"
                />
              </UFormField>
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
                description="如 打屁股/捆绑/训诫/SM/强制高潮;态度与承受/施予定位影响叙事演绎"
              >
                <div class="space-y-2">
                  <div
                    v-for="(k, i) in sel.kinks ?? []"
                    :key="i"
                    class="flex items-center gap-2"
                  >
                    <UInput
                      v-model="k.theme"
                      placeholder="玩法,如 打屁股"
                      class="min-w-0 flex-1"
                    />
                    <USelectMenu
                      :model-value="k.view ?? undefined"
                      :items="KINK_VIEWS"
                      :search-input="false"
                      class="w-28 shrink-0"
                      @update:model-value="v => (k.view = v ?? null)"
                    />
                    <USelectMenu
                      :model-value="k.role ?? undefined"
                      :items="KINK_ROLES"
                      :search-input="false"
                      class="w-24 shrink-0"
                      @update:model-value="v => (k.role = v ?? null)"
                    />
                    <UButton
                      icon="i-lucide-x"
                      color="error"
                      variant="ghost"
                      size="xs"
                      aria-label="删除喜好"
                      @click="removeKink(i)"
                    />
                  </div>
                  <div
                    v-if="!(sel.kinks ?? []).length"
                    class="text-xs text-neutral-400"
                  >
                    暂无喜好,点击下方按钮添加
                  </div>
                  <UButton
                    label="添加喜好"
                    icon="i-lucide-plus"
                    color="neutral"
                    variant="soft"
                    size="xs"
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
                label="性欲强度(0-100)"
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
      <div class="flex justify-end gap-2">
        <UButton
          label="取消"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
        <UButton
          label="保存"
          icon="i-lucide-check"
          color="primary"
          :loading="saving"
          @click="onSave"
        />
      </div>
    </template>
  </UModal>
</template>
