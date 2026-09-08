<script setup lang="ts">
// v2 人物卡富展示(docs/format-v2.md §7.1):中文保留键 → 富展示(仅实际有值的属性,空槽位/「未知」不占行),
// 自由键/外来未知结构 → 通用"键:值"渲染(KeyValueView)。
// 消费端不假设字段存在与类型正确——值形状容忍,异版本怪字段按通用渲染展开、不崩。
const props = withDefaults(defineProps<{
  /** BookCharacter / SegmentCharacterFile 等中文键卡(保留键 + 自由区) */
  char: Record<string, unknown>
  /** 是否显示姓名标题(段文件浏览中默认显示) */
  showName?: boolean
}>(), { showName: true })

/** 保留键 → 显示标签(顺序即展示顺序;未列出的键全部走自由区通用渲染) */
const RESERVED: { key: string, label: string }[] = [
  { key: '性别', label: '性别' },
  { key: '年龄', label: '年龄' },
  { key: '别名', label: '别名' },
  { key: '身份', label: '身份' },
  { key: '外貌', label: '外貌' },
  { key: '性格', label: '性格' },
  { key: '说话风格', label: '说话风格' },
  { key: '背景', label: '背景' },
  { key: '能力', label: '能力' },
  { key: '目标', label: '目标' },
  { key: '恐惧', label: '恐惧' },
  { key: '弱点', label: '弱点' },
  { key: '秘密', label: '秘密' },
  { key: '首次出场', label: '首次出场' },
  { key: '关系', label: '关系' },
  { key: '性欲强度', label: '性压抑指数' },
  { key: '耐心', label: '耐心' },
  { key: '心软', label: '心软' },
  { key: '玩法喜好', label: '玩法喜好' },
  { key: '成人属性', label: '成人属性' }
]
const RESERVED_KEYS = new Set([...RESERVED.map(r => r.key), '姓名', '角色', '已死亡', '弧线'])

/** 值是否实际有内容:空串/空数组/空对象/「未知」都算无(落卡时「未知」已剔除,这里兜底旧数据) */
function hasRealValue(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') {
    const s = v.trim()
    return !!s && s !== '未知'
  }
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0
  return true
}

/** 保留键只展示实际有值的属性(自由属性形式:有内容才占一行,不再渲染固定空槽位) */
const visibleReserved = computed(() => RESERVED.filter(r => hasRealValue(props.char[r.key])))

const name = computed(() => (typeof props.char['姓名'] === 'string' ? props.char['姓名'].trim() : '') || '未命名')
const role = computed(() => (typeof props.char['角色'] === 'string' ? props.char['角色'].trim() : ''))
/** 段角色文件没有「角色」键:不显示徽章(避免误导性默认值) */
const hasRole = computed(() => !!role.value)
const dead = computed(() => props.char['已死亡'] === true)

/** 关系数值行:对象(值) 值:说明 */
const relRows = computed(() => {
  const raw = props.char['关系']
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => {
      const obj = typeof r['对象'] === 'string' ? r['对象'].trim() : ''
      if (!obj) return null
      const val = typeof r['值'] === 'number' ? r['值'] : null
      const desc = typeof r['说明'] === 'string' ? r['说明'].trim() : ''
      return { obj, val, desc }
    })
    .filter((x): x is { obj: string, val: number | null, desc: string } => !!x)
})

/** 自由区键(保留键之外,保持原始顺序) */
const freeEntries = computed(() =>
  Object.entries(props.char).filter(([k]) => !RESERVED_KEYS.has(k)))

/** 弧线总结(自由对象,单独一块展示) */
const arc = computed(() => (props.char['弧线'] && typeof props.char['弧线'] === 'object' ? props.char['弧线'] as Record<string, unknown> : null))

function roleColor(r: string) {
  if (r === '主角') return 'primary'
  if (r === '反派') return 'error'
  return 'neutral'
}
</script>

<template>
  <div class="min-w-0 space-y-2 text-sm">
    <!-- 姓名 + 角色 + 死亡 -->
    <div
      v-if="showName"
      class="flex flex-wrap items-center gap-1.5"
    >
      <span class="font-semibold">{{ name }}</span>
      <UBadge
        v-if="hasRole"
        :color="roleColor(role)"
        variant="soft"
        size="sm"
      >
        {{ role }}
      </UBadge>
      <UBadge
        v-if="dead"
        color="error"
        variant="subtle"
        size="sm"
      >
        已死亡
      </UBadge>
    </div>

    <!-- 保留键富展示(仅实际有值的属性) -->
    <KeyValueView
      v-for="r in visibleReserved"
      :key="r.key"
      :label="r.label"
      :value="char[r.key]"
    />
    <!-- 关系(自定义行) -->
    <div
      v-if="relRows.length"
      class="flex items-baseline gap-2"
    >
      <span class="min-w-20 shrink-0 text-xs font-medium text-neutral-500 dark:text-neutral-400">关系</span>
      <div class="min-w-0 flex-1 space-y-0.5">
        <p
          v-for="r in relRows"
          :key="r.obj"
          class="text-sm"
        >
          {{ r.obj }}<template v-if="r.val != null">
            ({{ r.val > 0 ? '+' : '' }}{{ r.val }})
          </template><template v-if="r.desc">
            :{{ r.desc }}
          </template>
        </p>
      </div>
    </div>

    <!-- 弧线总结(自由对象,单独块) -->
    <div
      v-if="arc"
      class="rounded-lg bg-neutral-50 p-2.5 dark:bg-neutral-800/60"
    >
      <p class="mb-1 text-xs font-semibold text-neutral-500">
        角色弧线
      </p>
      <p
        v-if="typeof arc.summary === 'string' && arc.summary.trim()"
        class="text-sm"
      >
        {{ arc.summary }}
      </p>
      <p
        v-if="typeof arc.detail === 'string' && arc.detail.trim()"
        class="mt-1 text-xs text-neutral-500"
      >
        {{ arc.detail }}
      </p>
    </div>

    <!-- 自由区:通用键值渲染 -->
    <KeyValueView
      v-for="[k, v] in freeEntries"
      :key="k"
      :label="k"
      :value="v"
    />
  </div>
</template>
