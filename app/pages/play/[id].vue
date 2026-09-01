<script setup lang="ts">
// /play/[id] — 选角页(本地作品):展示人物卡 → 选择身份 → 创建本地游戏会话 → 进入游戏
import { getWork, touchWork } from '../../utils/worldGen'
import { createLocalGame } from '../../utils/gameStore'
import { isAdultModeEnabled, setAdultModeEnabled } from '../../utils/adultMode'
import { ensureDesires } from '#shared/game'
import { uuid } from '#shared/novel'
import type { CharacterArc, GameState, LocalGame } from '#shared/novel'

useHead({ title: 'AI Word2World · 选择身份' })

const route = useRoute()
const router = useRouter()
const workId = route.params.id as string
const toast = useToast()

const work = ref<Awaited<ReturnType<typeof getWork>>>(null)
const loadError = ref<string | null>(null)
const creating = ref(false)

onMounted(async () => {
  // 兼容提示的关闭记录(localStorage,读不到视为未关闭)
  try {
    legacyHintDismissed.value = localStorage.getItem(`legacy-world-hint:${workId}`) === '1'
  } catch {
    legacyHintDismissed.value = false
  }
  work.value = await getWork(workId)
  if (!work.value) loadError.value = '本地未找到该作品'
  else void touchWork(workId)
})

const cards = computed(() => work.value?.overlay?.characters ?? [])
const characterArcs = computed<CharacterArc[]>(() => work.value?.characterArcs ?? [])

/** 名字归一化(去空白;cast / 弧线与人物卡名匹配共用) */
function normName(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, '').trim()
}

/** 该角色的独立故事线(有则扮演时以此为主叙事线) */
function arcOf(name: string): CharacterArc | undefined {
  if (!characterArcs.value.length) return undefined
  const key = normName(name)
  return characterArcs.value.find(a => normName(a.character) === key)
    ?? characterArcs.value.find(a => normName(a.character).includes(key) || key.includes(normName(a.character)))
}

/** 选角卡片按角色名取弧线(避免模板里对同一角色调两次) */
const arcByCardName = computed(() => {
  const map: Record<string, CharacterArc> = {}
  for (const c of cards.value) {
    const arc = arcOf(c.name)
    if (arc) map[c.name] = arc
  }
  return map
})

/** 判断角色是否在所选细纲段登场(cast 与卡名/别名/昵称做宽松匹配;cast 缺失时全部视为登场) */
const isInBeatCast = (() => {
  const match = (card: { name: string, alias?: string | null }, cast: string[]): boolean => {
    if (!cast.length) return true // cast 缺失(旧作品/LLM 未填):不误伤,全部可选
    const cardNames = [card.name, card.alias ?? ''].map(normName).filter(Boolean)
    return cast.some((c) => {
      const k = normName(c)
      return cardNames.includes(k)
        || cardNames.some(n => n.includes(k) || k.includes(n))
    })
  }
  return (card: { name: string, alias?: string | null }) => {
    if (openingMode.value !== 'beat') return true
    const cast = selectedBeat.value?.cast ?? []
    return match(card, cast)
  }
})()

/** 残缺作品拦截:角色卡过少或多数卡缺少基本人设信息时禁止开局。
 *  覆盖两类来源:本修复前生成的旧作品(成书输出被截断只留下主角)、用户手动删卡后的极端状态。 */
const brokenReason = computed(() => {
  const list = cards.value
  if (!work.value) return null
  if (list.length === 0) return '该作品没有识别到任何角色卡'
  if (list.length < 2) return `该作品只识别到 ${list.length} 张角色卡`
  const shell = list.filter(c => !c.background?.trim() && !(c.personality ?? []).length && !c.appearance?.trim()).length
  if (shell * 2 >= list.length) return `该作品 ${list.length} 张角色卡中有 ${shell} 张缺少基本人设信息(背景/性格/外貌全空)`
  return null
})
/** 作品章节(细纲段 startChar 定位与正文窗口取用) */
const chapters = computed(() => work.value?.chapters ?? [])

// ---- 开场方式:ai=AI 生成开场供选择(默认) beat=按细纲段开始 custom=玩家输入背景故事 ----
// 不用章节:上传 txt 的章节识别不可靠,细纲段按字数切分,兼容任意 txt。

type OpeningMode = 'ai' | 'beat' | 'custom'
const openingMode = ref<OpeningMode>('ai')
const openingModes = [
  { label: 'AI 生成开场', value: 'ai', description: '进入游戏后生成 4 个开场设定供选择' },
  { label: '按细纲段开始', value: 'beat', description: '从所选细纲段的情节展开' },
  { label: '输入背景故事', value: 'custom', description: '按你写的背景设定生成开场' }
] satisfies { label: string, value: OpeningMode, description: string }[]

const customScene = ref('')

// ---- 细纲段:storyline 按段序(带 startChar,直接在全书拼接正文上取原文窗口,不经章节) ----

const beats = computed(() => work.value?.storyline ?? [])
const beatIndex = ref(0)
const selectedBeat = computed(() => beats.value[beatIndex.value] ?? null)

/** 全书拼接正文(与 splitUnits 的 join('\n') 对齐) */
const joinedText = computed(() => chapters.value.map(c => c.content).join('\n'))

/** 从细纲段起始位置取一段正文窗口(约 2500 字) */
function beatTextWindow(beat: { startChar: number }): string {
  if (beat.startChar < 0 || beat.startChar >= joinedText.value.length) return ''
  return joinedText.value.slice(beat.startChar, beat.startChar + 2500)
}

/** 按所选模式构造开局设定;返回 error 表示缺必填内容 */
function buildOpening(): { opening: LocalGame['opening'], currentBeat?: number | null, error?: string } {
  if (openingMode.value === 'beat') {
    const beat = selectedBeat.value
    if (!beat) return { opening: undefined, error: '请选择起始细纲段' }
    const label = beat.label || `第${beat.index + 1}段`
    const prev = beats.value[beatIndex.value - 1]
    const next = beats.value[beatIndex.value + 1]
    return {
      opening: {
        mode: 'beat',
        beatIndex: beat.index,
        beatTitle: label,
        beatSummary: beat.summary,
        beatText: beatTextWindow(beat),
        ...(prev ? { prevBeat: { title: prev.label, text: prev.summary } } : {}),
        ...(next ? { nextBeat: { title: next.label, text: next.summary } } : {})
      },
      currentBeat: beat.index
    }
  }
  if (openingMode.value === 'custom') {
    const scene = customScene.value.trim()
    if (!scene) return { opening: undefined, error: '请先输入背景故事' }
    return { opening: { mode: 'custom', scene } }
  }
  return { opening: { mode: 'ai' } }
}

/** 成人模式开关(本地偏好,默认关闭):开启后本场游玩的成人内容频率大幅上升 */
const adultOn = ref(isAdultModeEnabled())
watch(adultOn, v => setAdultModeEnabled(v))

async function startAs(characterName: string) {
  if (creating.value) return
  // 「按细纲段开始」时,该段未登场的角色不可选(cast 缺失/匹配失败时不拦截)
  if (openingMode.value === 'beat' && selectedBeat.value) {
    const card = cards.value.find(c => c.name === characterName)
    if (card && !isInBeatCast(card)) {
      toast.add({ title: '该角色本段未登场', description: `细纲「${selectedBeat.value.label || `第${selectedBeat.value.index + 1}段`}」中${characterName}没有戏份,请选择该段登场的角色,或切换到其他开场方式`, color: 'error' })
      return
    }
  }
  const { opening, currentBeat, error } = buildOpening()
  if (error) {
    toast.add({ title: error, color: 'error' })
    return
  }
  creating.value = true
  try {
    const relationships: Record<string, number> = {}
    for (const c of cards.value) {
      if (c.name !== characterName) relationships[c.name] = 0
    }
    const state: GameState = ensureDesires({ location: '', time: '', health: '良好', mood: '平静', relationships, quests: [], flags: {} }, cards.value)
    const gameId = uuid()
    await createLocalGame({ id: gameId, workId, playerName: characterName, characterName, state, opening, currentBeat })
    router.push(`/games/${gameId}`)
  } finally {
    creating.value = false
  }
}

function roleColor(role: string | undefined) {
  if (role === '主角') return 'primary'
  if (role === '反派') return 'error'
  return 'neutral'
}

// ---- 世界详情弹窗(查看生成产物/编辑概览元数据) ----
const worldDetailOpen = ref(false)

// ---- 旧版世界兼容提示:缺细纲/实体库/元数据时告知降级影响与补齐入口(每作品只提醒一次) ----
const legacyHintDismissed = ref(true)

/** 旧版世界缺失的能力清单(空数组 = 新版完整世界,不提示) */
const missingParts = computed(() => {
  const w = work.value
  if (!w) return []
  const parts: string[] = []
  if (!w.storyline?.length) parts.push('细纲故事线(按细纲段开局与防剧情漂移依赖它)')
  if (!w.entities) parts.push('实体库(世界规则/势力/伏笔的剧情联动依赖它)')
  if (!w.overlay?.tags?.length && !w.overlay?.orientation && !w.overlay?.setting) parts.push('世界观元数据(性向/尺度/设定)')
  return parts
})

const legacyWork = computed(() => missingParts.value.length > 0)

function dismissLegacyHint() {
  legacyHintDismissed.value = true
  try {
    localStorage.setItem(`legacy-world-hint:${workId}`, '1')
  } catch {
    /* localStorage 不可用时仅本次会话内不再提示 */
  }
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">
          {{ work?.title || '作品' }}
        </h1>
        <p class="text-sm text-neutral-500">
          {{ work?.overlay?.summary || '选择你要扮演的角色' }}
        </p>
        <p
          v-if="work?.overlay?.orientation || work?.overlay?.setting"
          class="mt-1 text-xs text-neutral-500"
        >
          <span v-if="work.overlay.orientation">{{ work.overlay.orientation }}</span>
          <span v-if="work.overlay.orientation && work.overlay.heat"> · </span>
          <span v-if="work.overlay.heat">{{ work.overlay.heat }}</span>
          <span v-if="work.overlay.setting"> · {{ work.overlay.setting }}</span>
        </p>
        <div
          v-if="work?.overlay?.tags?.length"
          class="mt-2 flex flex-wrap gap-1.5"
        >
          <UBadge
            v-for="tag in work.overlay.tags.slice(0, 8)"
            :key="tag"
            color="primary"
            variant="subtle"
            size="sm"
          >
            {{ tag }}
          </UBadge>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton
          label="世界详情"
          icon="i-lucide-globe"
          color="neutral"
          variant="outline"
          size="sm"
          @click="worldDetailOpen = true"
        />
        <UButton
          label="返回"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="outline"
          size="sm"
          to="/"
        />
      </div>
    </div>

    <UAlert
      v-if="loadError"
      color="error"
      variant="soft"
      :title="loadError"
    />

    <UAlert
      v-if="brokenReason"
      color="error"
      variant="soft"
      title="无法开局:角色识别不完整"
      :description="`${brokenReason}。残缺状态下开局无法正确扮演角色,请重新生成世界后再选角。`"
    >
      <template #actions>
        <UButton
          label="去重新生成世界"
          icon="i-lucide-sparkles"
          size="sm"
          color="error"
          variant="soft"
          :to="`/generate?from=work&id=${workId}`"
        />
        <UButton
          label="返回书架"
          icon="i-lucide-library"
          size="sm"
          color="neutral"
          variant="soft"
          to="/works"
        />
      </template>
    </UAlert>

    <!-- 旧版世界兼容提示:能玩但剧情联动不完整;严重残缺(brokenReason)时由上方硬提示接管,不再重复提醒 -->
    <UAlert
      v-if="legacyWork && !brokenReason && !legacyHintDismissed"
      class="mb-4"
      color="warning"
      variant="soft"
      icon="i-lucide-triangle-alert"
      title="该作品是旧版世界,部分剧情功能不完整"
      :close="true"
      @update:open="dismissLegacyHint"
    >
      <template #description>
        缺少:{{ missingParts.join(';') }}。不影响现在直接游玩;可在书架「更多 → 重新生成世界」用新管线补齐(同一来源已提取的部分 0 token 复用)。
      </template>
      <template #actions>
        <UButton
          label="重新生成世界"
          icon="i-lucide-sparkles"
          size="sm"
          color="warning"
          variant="soft"
          :to="`/generate?from=work&id=${workId}`"
        />
        <UButton
          label="返回书架"
          icon="i-lucide-library"
          size="sm"
          color="neutral"
          variant="soft"
          to="/works"
        />
      </template>
    </UAlert>

    <details
      v-if="work?.storyline?.length"
      class="mb-4 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900/60"
    >
      <summary class="cursor-pointer text-sm font-medium">
        故事线 · {{ work.storyline.length }} 段
      </summary>
      <ol class="mt-3 max-h-64 space-y-2 overflow-y-auto text-sm text-neutral-600 dark:text-neutral-400">
        <li
          v-for="beat in work.storyline"
          :key="beat.index"
        >
          <span class="font-medium text-highlighted">段{{ beat.index + 1 }}</span>
          {{ beat.summary }}
        </li>
      </ol>
    </details>

    <UCard class="mb-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="font-semibold">
            成人模式
          </p>
          <p class="text-xs text-neutral-500">
            开启后,本场游玩中成人内容出现频率大幅上升,并明显偏向训诫、BDSM、打屁股、捆绑、强制等亚文化题材,按角色性欲强度与当前性欲值推进;可在个人中心随时调整
          </p>
        </div>
        <USwitch v-model="adultOn" />
      </div>
    </UCard>

    <UCard class="mb-4">
      <div class="flex flex-col gap-3">
        <div>
          <p class="font-semibold">
            开场方式
          </p>
          <p class="text-xs text-neutral-500">
            决定游戏从什么情节开始,可在开始前随时切换
          </p>
        </div>
        <URadioGroup
          v-model="openingMode"
          :items="openingModes"
          variant="card"
          size="sm"
        />
        <div
          v-if="openingMode === 'beat'"
          class="flex flex-col gap-2"
        >
          <p
            v-if="beats.length === 0"
            class="text-xs text-amber-600 dark:text-amber-400"
          >
            该作品没有细纲段,无法按细纲开始(请重新生成世界)
          </p>
          <template v-else>
            <USelect
              v-model="beatIndex"
              :items="beats.map((b, i) => ({ label: `${b.label || `第${i + 1}段`}: ${b.summary.slice(0, 40)}${b.summary.length > 40 ? '…' : ''}`, value: i }))"
              value-key="value"
              label-key="label"
            />
            <p
              v-if="selectedBeat"
              class="whitespace-pre-line text-xs text-neutral-500"
            >
              <span class="font-medium text-neutral-700 dark:text-neutral-300">{{ selectedBeat.label || `第${selectedBeat.index + 1}段` }}</span>
              {{ selectedBeat.summary }}
              <template v-if="selectedBeat.place">
                · {{ selectedBeat.place }}
              </template>
              <template v-if="selectedBeat.cast?.length">
                · {{ selectedBeat.cast.slice(0, 4).join('、') }}
              </template>
            </p>
            <p
              v-if="selectedBeat"
              class="text-[11px] text-neutral-400"
            >
              将从该段起始位置开始演绎,并连带注入前一段背景与后一段走向
            </p>
            <p
              v-if="selectedBeat && selectedBeat.cast?.length"
              class="text-[11px] text-amber-600 dark:text-amber-400"
            >
              该段登场的角色可正常选择;未登场的角色已置灰(切换细纲段或开场方式后可选)
            </p>
          </template>
        </div>
        <UTextarea
          v-if="openingMode === 'custom'"
          v-model="customScene"
          autoresize
          :rows="3"
          placeholder="写一段背景设定,AI 将据此生成开场剧情,例如:我是落魄剑客,在雨夜酒馆里遇到了一个神秘女子…"
        />
        <p
          v-if="openingMode === 'ai'"
          class="text-xs text-neutral-500"
        >
          进入游戏后,AI 会先生成 4 个开场设定供你选择(默认选中第一个,可改选)
        </p>
      </div>
    </UCard>

    <div
      v-if="cards.length && !brokenReason"
      class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <UCard
        v-for="c in cards"
        :key="c.name"
        class="flex h-full flex-col transition"
        :class="isInBeatCast(c)
          ? 'cursor-pointer hover:border-primary-400'
          : 'cursor-not-allowed opacity-50'"
        :ui="{ body: 'flex flex-1 flex-col' }"
        @click="startAs(c.name)"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-base font-semibold">
              {{ c.name }}
            </p>
            <p class="text-xs text-neutral-500">
              {{ c.identity || '未知身份' }}
            </p>
          </div>
          <div class="flex flex-col items-end gap-1">
            <UBadge
              :color="roleColor(c.role)"
              variant="soft"
            >
              {{ c.role || '配角' }}
            </UBadge>
            <UBadge
              v-if="arcByCardName[c.name]"
              color="primary"
              variant="outline"
              size="sm"
            >
              故事线 {{ arcByCardName[c.name]!.beats.length }} 段
            </UBadge>
            <UBadge
              v-if="openingMode === 'beat' && !isInBeatCast(c)"
              color="neutral"
              variant="outline"
              size="sm"
            >
              该段未登场
            </UBadge>
          </div>
        </div>
        <p
          v-if="c.personality?.length"
          class="mt-3 text-xs text-neutral-400"
        >
          {{ c.personality.join(' · ') }}
        </p>
        <p
          v-if="c.background"
          class="mt-2 line-clamp-3 text-sm text-neutral-600 dark:text-neutral-300"
        >
          {{ c.background }}
        </p>
        <p
          v-if="arcByCardName[c.name]?.summary"
          class="mt-2 line-clamp-3 text-xs text-neutral-500 dark:text-neutral-400"
        >
          {{ arcByCardName[c.name]!.summary }}
        </p>
        <div class="mt-auto flex items-center justify-between pt-3 text-xs text-neutral-400">
          <span>{{ c.relationships?.length ? `关系网 ${c.relationships.length} 条` : '' }}</span>
          <span>{{ c.first_appearance || '' }}</span>
        </div>
        <UButton
          block
          class="mt-4"
          color="primary"
          variant="soft"
          :loading="creating"
          :disabled="!isInBeatCast(c)"
          @click.stop="startAs(c.name)"
        >
          {{ isInBeatCast(c) ? `扮演${c.name}` : '该段未登场,不可扮演' }}
        </UButton>
      </UCard>
    </div>

    <!-- 世界详情弹窗 -->
    <WorldDetailModal
      v-model:open="worldDetailOpen"
      :work-id="workId"
    />
  </div>
</template>
