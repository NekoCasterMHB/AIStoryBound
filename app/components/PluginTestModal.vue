<script setup lang="ts">
// PluginTestModal.vue — 功能插件「测试能力」模态框(个人中心 → 功能插件 → 测试能力):
// AI 编排交互式测试:逐个能力「说明 → 输出指令 → 适配器执行 → 提问是否生效 → 等待用户反馈」,
// 用户反馈后 AI 继续下一个能力,循环直到全部测完。
// 预制提示词暴露「已启用且已连接」的插件能力;指令经 ToyApi 真实写入当前连接,日志黄色高亮。
import { describePlugin } from '#shared/plugin'
import type { PluginSpec } from '#shared/plugin'
import { narratorDeviceSpec } from '#shared/game'
import { isAdapterEnabled, DEFAULT_TOY_SETTINGS } from '#shared/toy'
import type { ToyAdapter, ToySettings } from '#shared/toy'
import { aiChat } from '../utils/aiRelay'
import { toyController } from '../toy/api'
import { loadToySettings } from '../toy/store'
import { loadAllAdapters, loadAllPluginSpecs } from '../toy/runtime/adapter-loader'

const open = defineModel<boolean>('open', { default: false })
const toast = useToast()

const loading = ref(false)
const specs = ref<PluginSpec[]>([])
const adapters = ref<ToyAdapter[]>([])
const settings = ref<ToySettings>({ ...DEFAULT_TOY_SETTINGS })

/** 该插件是否已连接(多连接:按槽位判断) */
function isConnectedTo(id: string): boolean {
  return !!toyController.slotOf(id)?.connected
}

/** 已启用且已连接的能力清单(仅这些暴露给 AI) */
const connectedSpecs = computed(() => specs.value.filter(s => isAdapterEnabled(settings.value, s.descriptor.id) && isConnectedTo(s.descriptor.id)))

// ---- 交互式对话 ----
const running = ref(false)
interface ChatTurn { role: 'assistant' | 'user', content: string }
const chat = ref<ChatTurn[]>([])
/** 每条 AI 回复中解析出并执行的指令日志(黄色高亮) */
interface CapLog {
  adapter: string
  capability: string
  raw: string
  ok: boolean
  detail: string
}
const logs = ref<CapLog[]>([])
/** 当前 AI 回复给出的反馈选项(点选代替输入) */
const options = ref<string[]>([])
/** 测试是否已开始 / 是否仍在等待选择 */
const started = ref(false)
const awaitingFeedback = ref(false)

/** 系统提示词:AI 编排逐能力测试,一次一个,先说明再指令,执行后给选项等反馈 */
function buildSystemPrompt(): string {
  if (!connectedSpecs.value.length) return ''
  const briefs = connectedSpecs.value.map(spec => describePlugin(spec, true))
  const deviceBlock = narratorDeviceSpec(briefs)
  return `你是功能插件能力测试员,正在对玩家已连接的设备逐个测试能力。已连接设备能力如下:\n${deviceBlock}\n\n`
    + '测试流程(严格遵守,一次只测一个能力):\n'
    + '1. 第一轮就直接开始第一个能力的测试:先一句正文引出(如场景化描述) + 内联测试指令 + 末尾 [[options:…]] 反馈选项,三者自然融合成一整段输出,指令标记埋入正文之中,不要生硬列出、不要只输出「现在开始」之类的开场白或寒暄(只输出开场白视为无效,会被要求重来);\n'
    + '2. 先说「接下来测试 [能力名]」,一句话说明这个能力的作用;\n'
    + '3. 输出对应的测试指令(先从中等强度如 50 开始;带模式给模式 1,持续 3 秒;调教能力可先 [[dev:…]] 再 [[wave:…]]);\n'
    + '4. 末尾必须输出玩家可选的反馈选项,格式为 [[options:选项1|选项2|选项3]]。选项必须覆盖强度调节,通常包含:\n'
    + '   - 「生效」或「生效(强度 X)」;\n'
    + '   - 「未生效」;\n'
    + '   - 强度档位调节,如「调低到 20」「调高到 80」「强度 50」等(从低到高至少 2 档,让玩家验证调大调小是否都正常);\n'
    + '   - 按需「有异常:现象」或「停止(强度 0)」;\n'
    + '5. 等玩家选择选项后:选强度档位 → 按该强度重新输出指令测试该能力;选生效 → 进入下一个能力;选未生效/有异常 → 根据现象重试或说明原因后进入下一个;\n'
    + '6. 全部能力测试完成后,总结测试结果并结束(此时不要再输出 [[options:…]] 选项)。\n'
    + '指令用内联标记埋入正文(对玩家不可见、不得复述语法),每步一次只输出当前能力的指令;[[options:…]] 标记对玩家同样不可见,只作反馈选项。\n'
    + '指令格式注意:[[dev:插件id:功能id:强度[:模式[:秒数]]]],必须带插件 id 前缀(如 [[dev:sosexy:suction:50:1:3]]),因为玩家可能同时连接多个设备,靠插件 id 区分目标。'
}

async function startTest() {
  if (running.value || !connectedSpecs.value.length) return
  started.value = true
  running.value = true
  chat.value = []
  logs.value = []
  options.value = []
  const sys = buildSystemPrompt()
  if (!sys) return
  // 直接让 AI 开始第一项测试(无需用户先输入)
  await aiTurn([{ role: 'system', content: sys }])
  running.value = false
}

/** 点选反馈选项 → 追加到对话 → AI 继续 */
async function sendFeedback(option: string) {
  const text = option.trim()
  if (running.value || !started.value || !text) return
  options.value = []
  chat.value.push({ role: 'user', content: text })
  running.value = true
  const messages: { role: 'system' | 'assistant' | 'user', content: string }[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...chat.value.map(m => ({ role: m.role, content: m.content }))
  ]
  await aiTurn(messages)
  running.value = false
}

/** 从 AI 回复中提取 [[options:…]] 反馈选项(未出现则视为测试结束) */
function extractOptions(text: string): string[] {
  const m = text.match(/\[\[options:([^\]]+)\]\]/g)
  if (!m) return []
  const out: string[] = []
  for (const mark of m) {
    const inner = mark.slice('[[options:'.length, -2)
    for (const o of inner.split('|')) {
      const t = o.trim()
      if (t && !out.includes(t)) out.push(t)
    }
  }
  return out
}

/** 测试指令(宽容格式:兼容可选插件 id 前缀,如 [[dev:sosexy:suction:20:1:3]] 与标准 [[dev:suction:20:1:3]]) */
interface TestCmd {
  type: 'dev' | 'wave' | 'stop'
  /** 可选的插件 id 前缀(宽容解析剥出;仅用于匹配,不强制) */
  adapter?: string
  function: string
  intensity?: number
  mode?: number
  duration?: number
  pattern?: string
  /** 指令原文(日志展示用) */
  raw: string
}

const WAVE_PATTERNS = new Set(['sine', 'pulse', 'sawtooth', 'heartbeat', 'random', 'constant', 'auto'])

/** 宽容解析 AI 回复中的全部控制指令(不依赖 narrStream 的标准 4 段格式) */
function parseTestCommands(text: string): TestCmd[] {
  const cmds: TestCmd[] = []
  const re = /\[\[(dev|wave|stop):([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const type = m[1] as TestCmd['type']
    const parts = m[2]!.split(':').map(x => x.trim()).filter(x => x !== '')
    const raw = m[0]!
    if (type === 'dev') {
      // 期望 [adapter:]fn:intensity[:mode[:duration]];第二段非数字 → 首段为插件 id 前缀
      let adapter: string | undefined
      let fn = parts[0]!
      let intensity = Number(parts[1])
      if (!Number.isFinite(intensity) && parts[1] != null) {
        adapter = parts[0]
        fn = parts[1]!
        intensity = Number(parts[2])
      }
      if (!fn || !Number.isFinite(intensity)) continue
      const cmd: TestCmd = { type, function: fn, intensity: Math.round(intensity), raw }
      if (adapter) cmd.adapter = adapter
      const mode = parts[adapter ? 3 : 2]
      if (mode != null && mode !== '' && Number.isFinite(Number(mode))) cmd.mode = Math.round(Number(mode))
      const dur = parts[adapter ? 4 : 3]
      if (dur != null && dur !== '' && Number.isFinite(Number(dur))) cmd.duration = Math.round(Number(dur))
      cmds.push(cmd)
    } else if (type === 'wave') {
      // 期望 [adapter:]fn:pattern[:duration];第二段非合法形态 → 首段为插件 id 前缀
      let adapter: string | undefined
      let fn = parts[0]!
      let pattern = parts[1] ?? ''
      if (!WAVE_PATTERNS.has(pattern)) {
        adapter = parts[0]
        fn = parts[1]!
        pattern = parts[2] ?? ''
      }
      if (!fn || !pattern) continue
      const cmd: TestCmd = { type, function: fn, pattern, raw }
      if (adapter) cmd.adapter = adapter
      const dur = parts[adapter ? 3 : 2]
      if (dur != null && dur !== '' && Number.isFinite(Number(dur))) cmd.duration = Math.round(Number(dur))
      cmds.push(cmd)
    } else {
      const fn = parts[parts.length - 1]!
      if (!fn) continue
      cmds.push({ type, function: fn, raw })
    }
  }
  return cmds
}

/** 对话区展示用:剥掉所有指令/选项标记,只留正文 */
function displayContent(text: string): string {
  return text.replace(/\[\[(?:dev|wave|stop|pause|options):[^\]]*\]\]/g, '').trim()
}

/** 一次 AI 回合:流式回复 → 展示 → 解析指令执行 → 给出反馈选项。
 *  空转兜底:回复中既无指令也无选项(如只输出了开场白)时,自动提示重试一次,而非当作测试结束 */
async function aiTurn(messages: { role: 'system' | 'assistant' | 'user', content: string }[]) {
  let collected = ''
  try {
    const res = await aiChat(messages, { temperature: 0.3 }, {
      onDelta: (d) => { collected += d }
    })
    if (!res.ok) {
      toast.add({ title: '测试中断', description: res.message, color: 'error' })
      return
    }
    chat.value.push({ role: 'assistant', content: collected })
    // 宽容解析指令并执行(执行失败不阻塞)
    const cmds = parseTestCommands(collected)
    await executeTokens(cmds)
    const opts = extractOptions(collected)
    const hasCmd = cmds.length > 0

    // 空转:AI 只输出了开场白/解释,没有指令也没有选项 → 内部催促重试一次(不显示为玩家发言)
    if (!hasCmd && opts.length === 0) {
      const firstReply = collected // 第一轮完整回复(作为上下文传给重试)
      collected = ''
      const retry = await aiChat(
        [
          ...messages,
          { role: 'assistant', content: firstReply },
          { role: 'user', content: '请直接开始第一个能力的测试:正文 + 指令标记 + [[options:…]] 反馈选项,不要只输出开场白。' }
        ],
        { temperature: 0.3 },
        { onDelta: (d) => { collected += d } }
      )
      if (!retry.ok) {
        toast.add({ title: '测试中断', description: retry.message, color: 'error' })
        return
      }
      chat.value.push({ role: 'assistant', content: collected })
      const cmds2 = parseTestCommands(collected)
      await executeTokens(cmds2)
      options.value = extractOptions(collected)
      awaitingFeedback.value = options.value.length > 0
      return
    }

    options.value = opts
    awaitingFeedback.value = options.value.length > 0
  } catch (e) {
    toast.add({ title: '测试失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

/** 逐条执行解析出的指令:仅对已连接能力执行(未连接 → 提示先连接) */
async function executeTokens(cmds: TestCmd[]): Promise<void> {
  for (const c of cmds) await executeOne(c)
}

/** 测试用设置:用户主动测试即视为已授权 AI 控制(总开关 + 分功能全放行),仅保留强度上限等硬限制。
 *  不污染用户的持久化设置(只读副本)。 */
function testSettings(): ToySettings {
  return { ...settings.value, aiEnabled: true, aiEnabledFunctions: undefined }
}

async function executeOne(t: TestCmd): Promise<void> {
  const fn = t.function
  // 目标插件:优先按指令携带的插件 id(t.adapter)匹配;无前缀时回退按功能 id 找到唯一声明它的插件
  const spec = t.adapter
    ? connectedSpecs.value.find(s => s.descriptor.id === t.adapter)
    : connectedSpecs.value.find(s => s.capabilities.some(c => c.id === fn))
  const adapter = adapters.value.find(a => a.manifest.id === spec?.descriptor.id)
  const cap = spec?.capabilities.find(c => c.id === fn)
  if (!spec || !adapter || !cap) {
    const why = t.adapter
      ? `插件「${t.adapter}」未连接或没有能力「${fn}」`
      : '未找到声明该能力的已连接插件,请先连接设备后重试'
    logs.value.push({ adapter: t.adapter ?? '?', capability: fn, raw: t.raw, ok: false, detail: why })
    return
  }
  const label = `${spec.descriptor.name} · ${cap.name}`
  const s = testSettings()

  try {
    if (t.type === 'dev') {
      const res = await toyController.execute(
        { adapter: spec.descriptor.id, function: t.function, intensity: t.intensity ?? 0, ...(t.mode != null ? { mode: t.mode } : {}), ...(t.duration != null ? { duration: t.duration } : {}) },
        { source: 'ai', settings: s }
      )
      logs.value.push({ adapter: label.split(' · ')[0]!, capability: cap.name, raw: t.raw, ok: res.ok, detail: res.ok ? '✓ 已执行' : res.reason })
    } else if (t.type === 'wave') {
      const res = await toyController.startWaveForAI(t.function, t.pattern, t.duration, s)
      logs.value.push({ adapter: label.split(' · ')[0]!, capability: cap.name, raw: t.raw, ok: res.ok, detail: res.ok ? '✓ 已启动调教' : res.reason })
    } else {
      toyController.stopWave(t.function)
      logs.value.push({ adapter: label.split(' · ')[0]!, capability: cap.name, raw: t.raw, ok: true, detail: '✓ 已停止调教' })
    }
  } catch (e) {
    logs.value.push({ adapter: label.split(' · ')[0]!, capability: cap.name, raw: t.raw, ok: false, detail: e instanceof Error ? e.message : String(e) })
  }
}

/** 指令 token → 原始写法(日志展示用) */
function errText(e: unknown): string {
  if (e instanceof Error) {
    const data = (e as { data?: { statusMessage?: string } }).data
    return data?.statusMessage || e.message
  }
  return String(e)
}

watch(open, async (v) => {
  if (!v) return
  loading.value = true
  logs.value = []
  chat.value = []
  options.value = []
  started.value = false
  awaitingFeedback.value = false
  try {
    const [specList, adapterList, s] = await Promise.all([
      loadAllPluginSpecs(),
      loadAllAdapters(),
      loadToySettings()
    ])
    specs.value = specList
    adapters.value = adapterList
    settings.value = s
  } catch (e) {
    toast.add({ title: '加载插件失败', description: errText(e), color: 'error' })
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="测试功能插件"
    description="AI 编排逐能力测试:说明 → 执行 → 询问是否生效,逐个完成"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <div
        v-if="loading"
        class="flex items-center justify-center gap-2 py-12 text-sm text-neutral-500"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 animate-spin"
        />
        正在加载插件能力…
      </div>

      <div
        v-else-if="!connectedSpecs.length"
        class="py-10 text-center text-sm text-neutral-500"
      >
        没有已连接的功能插件,请先在插件列表启用并连接设备后再测试
      </div>

      <template v-else>
        <!-- 能力概览 -->
        <p class="mb-3 text-xs text-neutral-500">
          已连接 {{ connectedSpecs.length }} 个插件 · {{ connectedSpecs.reduce((n, s) => n + s.capabilities.length, 0) }} 项能力
          <span class="ml-2 text-neutral-400">AI 将逐个测试并询问你是否生效</span>
        </p>

        <!-- 未开始:开始测试按钮 -->
        <div
          v-if="!started"
          class="flex justify-center py-6"
        >
          <UButton
            icon="i-lucide-play"
            color="primary"
            :loading="running"
            @click="startTest"
          >
            开始测试
          </UButton>
        </div>

        <template v-else>
          <!-- 对话区(角色状态气泡) -->
          <div class="max-h-72 space-y-3 overflow-y-auto pr-1">
            <div
              v-for="(t, i) in chat"
              :key="i"
              class="flex"
              :class="t.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed"
                :class="t.role === 'user'
                  ? 'bg-primary/10 text-primary-700 dark:text-primary-300'
                  : 'border border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300'"
              >
                {{ displayContent(t.content) }}
              </div>
            </div>
            <div
              v-if="running"
              class="flex items-center gap-2 text-xs text-neutral-500"
            >
              <UIcon
                name="i-lucide-loader-circle"
                class="size-3.5 animate-spin"
              />
              AI 正在输出…
            </div>
          </div>

          <!-- 指令执行日志(黄色高亮;测试开始后常驻显示,空态给占位) -->
          <div
            v-if="started"
            class="mt-4"
          >
            <p class="mb-1 text-xs font-medium text-neutral-500">
              指令执行{{ logs.length ? `(${logs.length})` : '' }}
            </p>
            <div
              v-if="logs.length"
              class="max-h-40 space-y-1.5 overflow-y-auto"
            >
              <div
                v-for="(log, i) in logs"
                :key="i"
                class="rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-400"
              >
                <span class="font-semibold">{{ log.adapter }} · {{ log.capability }}</span>
                <code class="ml-2 text-[11px] opacity-80">{{ log.raw }}</code>
                <span
                  class="ml-2"
                  :class="log.ok ? '' : 'font-medium text-red-500 dark:text-red-400'"
                >
                  {{ log.ok ? '✓' : '✗' }} {{ log.detail }}
                </span>
              </div>
            </div>
            <p
              v-else
              class="rounded-lg border border-dashed border-amber-300/40 px-3 py-2 text-xs text-neutral-400 dark:border-amber-700/40"
            >
              暂无指令执行记录(AI 输出指令后在此显示)
            </p>
          </div>

          <!-- 反馈选项(AI 给出的 [[options:…]] 点选) -->
          <div
            v-if="options.length"
            class="mt-4 flex flex-wrap gap-2"
          >
            <UButton
              v-for="o in options"
              :key="o"
              icon="i-lucide-mouse-pointer-click"
              color="primary"
              variant="soft"
              :disabled="running"
              @click="sendFeedback(o)"
            >
              {{ o }}
            </UButton>
          </div>
          <p
            v-else-if="started && !running && awaitingFeedback === false && chat.length"
            class="mt-4 text-center text-xs text-neutral-500"
          >
            测试已完成,可点击右上角关闭
          </p>
        </template>
      </template>
    </template>

    <template #footer>
      <div class="flex justify-end">
        <UButton
          color="neutral"
          variant="ghost"
          @click="open = false"
        >
          关闭
        </UButton>
      </div>
    </template>
  </UModal>
</template>
