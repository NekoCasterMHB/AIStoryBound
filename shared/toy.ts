// shared/toy.ts
// 玩具控制统一语义层(品牌无关,纯 TS 零 IO,浏览器/服务器/Node 共用)。
// AI 只产出归一化 DeviceEvent(强度一律 0-100),经 validateDeviceEvent 结构性校验
// + checkHardLimits 硬限制校验后,由 ToyApi 交给品牌适配器(ToyAdapter)翻译成字节帧执行。
// 适配器契约刻意保持「纯函数」形态:输入语义命令,输出字节帧,不做任何 IO——
// 因此玩家适配器可以安全地在 Worker 沙箱中运行,不接触蓝牙/网络/DOM。
// Tier 1 适配器 = 声明式 protocol 配置(帧模板/通道/初始化),由 createProtocolAdapter 自动生成,零代码;
// Tier 2 适配器 = 玩家提供 buildFrames 纯函数(见 app/toy/sdk-template)。

export type ToyFunctionId = string

/** 单功能能力声明(能力协商用:AI 只能使用 manifest 声明过的功能) */
export interface ToyFunctionCap {
  id: ToyFunctionId
  /** 功能名(界面展示;中文名由适配器 manifest.functionNames 提供) */
  name: string
  /** 归一化强度范围,缺省 0-100 */
  intensityRange?: [number, number]
  /** 是否支持模式档位(1..modeCount) */
  supportsMode?: boolean
  modeCount?: number
}

export interface ToyCapabilities {
  functions: ToyFunctionCap[]
  /** 是否要求逐功能一对通道发包(多数玩具要求一次只发一个功能,禁止多组塞一包) */
  perFunctionPair?: boolean
}

/** AI 下发的归一化设备事件(蓝图 §25:action/intensity/duration 抽象为 function/intensity/mode/duration) */
export interface DeviceEvent {
  /** 目标适配器 id(多适配器路由;缺省 = 当前连接设备)。须在适配器 capabilities.functions 内 */
  adapter?: string
  /** 功能 id(须在适配器 capabilities.functions 内) */
  function: ToyFunctionId
  /** 归一化强度 0-100(0=停止) */
  intensity: number
  /** 模式档位 1..modeCount(可选) */
  mode?: number
  /** 持续时长秒(可选;到时 ToyApi 自动停止) */
  duration?: number
}

/** 适配器收到的命令 = AI 事件同构(纯函数输入) */
export type NormalizedCommand = DeviceEvent

/** 单功能的限制覆盖(按能力单独设置;缺省 = 初始默认 100) */
export interface ToyFunctionLimit {
  maxIntensity?: number
}

/** 用户硬限制设置(IndexedDB 持久化;AI 来源受强度上限约束,时长上限对所有来源生效) */
export interface ToySettings {
  /** AI 控制总开关(关 = 拒绝所有 AI 来源的 device_events;手动面板控制不受此限) */
  aiEnabled: boolean
  /** AI 可控制的功能 id 列表(分能力单独启用;缺省/undefined = 全部允许;空数组 = 全部禁止) */
  aiEnabledFunctions?: string[]
  /** 默认最大持续时长秒(0=不限制;超限拒绝) */
  maxDuration: number
  /** 按能力单独的限制(功能 id -> 覆盖值;未设置的功能用默认值) */
  functionLimits?: Record<string, ToyFunctionLimit>
  /** 启用的适配器 id 列表(多选;缺省/undefined = 全部启用;禁用项不显示、不可连接) */
  enabledAdapters?: string[]
}

export const DEFAULT_TOY_SETTINGS: ToySettings = {
  aiEnabled: false,
  /** 全局时长上限(安全链:到期自动归零;AI 事件超 300s 拒绝) */
  maxDuration: 300
}

/** 能力最大强度的初始默认值(未单独设置时每项能力的上限;仅约束 AI 来源,手动控制不受限) */
export const DEFAULT_FUNCTION_MAX_INTENSITY = 100

/** 适配器是否启用(设置缺省 = 全部启用) */
export function isAdapterEnabled(settings: ToySettings, adapterId: string): boolean {
  return settings.enabledAdapters == null || settings.enabledAdapters.includes(adapterId)
}

/** 切换适配器启用状态,返回新的 enabledAdapters(空数组 = 全部禁用,与缺省语义区分) */
export function toggleAdapterEnabled(settings: ToySettings, adapterId: string, enabled: boolean): string[] {
  const cur = settings.enabledAdapters ?? []
  const next = enabled
    ? [...new Set([...cur, adapterId])]
    : cur.filter(id => id !== adapterId)
  return next
}

/** 功能是否允许 AI 控制(显式列表时只放行列表内;缺省 = 全部允许) */
export function isAiFunctionEnabled(settings: ToySettings, fnId: string): boolean {
  return settings.aiEnabledFunctions == null || settings.aiEnabledFunctions.includes(fnId)
}

/** 切换功能的 AI 控制开关,返回新的 aiEnabledFunctions(全部允许恢复 undefined) */
export function toggleAiFunctionEnabled(settings: ToySettings, fnId: string, enabled: boolean): string[] | undefined {
  const cur = settings.aiEnabledFunctions ?? []
  if (enabled) {
    const next = [...new Set([...cur, fnId])]
    return next.length === 0 ? undefined : next
  }
  const next = cur.filter(id => id !== fnId)
  return next.length === 0 ? [] : next
}

// ---- Tier 1 声明式协议配置(品牌差异全部收敛于此,抓包后只改配置不改代码) ----

export interface ToyProtocolConfig {
  gatt?: {
    serviceUuid: string
    writeUuid: string
    notifyUuid: string
    /** 写入是否带响应,缺省 true(Web Bluetooth 用 writeValueWithResponse) */
    writeWithResponse?: boolean
  }
  frame: {
    /** token 序列:字面量 "0xNN"(十六进制)或纯数字(十进制);占位符 [SEQ] [MODE1] [MODE2] [INTENSITY] [MODE] */
    template: string[]
    /** SEQ 是否随机,缺省 true(多数玩具不校验 SEQ,与官方 App 一致随机) */
    seqRandom?: boolean
    intensityRange: [number, number]
    modeRange?: [number, number]
  }
  /** 功能 id -> 通道对(强度通道 + 模式通道);缺 mode2 表示该功能无独立模式通道 */
  functions: Record<string, { mode1: string | number, mode2?: string | number, supportsMode?: boolean }>
  /** 连接后必发的初始化帧(如 SOSEXY 的 [SEQ] 01 00 01 00 C8 11 01) */
  init?: { frame: string[], notifyFragments?: number, waitMs?: number }
  /** 逐功能一对通道发包(缺省 true) */
  perFunctionPair?: boolean
}

export interface ToyAdapterManifest {
  /** 稳定标识(注册/存储主键) */
  id: string
  name: string
  version: string
  /** BLE 扫描名(Web Bluetooth 过滤用) */
  scanNames?: string[]
  /** 功能中文名(界面展示;未声明时用功能 id) */
  functionNames?: Record<string, string>
  /** 能力协商数据(Tier 2 由玩家声明;Tier 1 由 createProtocolAdapter 从 protocol 推导) */
  capabilities?: ToyCapabilities
  /** Tier 1 声明式协议配置(有则无需代码适配器) */
  protocol?: ToyProtocolConfig
}

/** 适配器契约:纯函数,无 IO。buildFrames 输入语义命令、输出字节帧。
 *  返回类型允许 Promise:Tier 2 沙箱适配器跨线程调用,异步只是边界,函数内部仍不得做 IO。 */
export interface ToyAdapter {
  manifest: ToyAdapterManifest
  /** 语义命令 → 字节帧(核心;实现方必须保证无 IO,Tier 1 为同步) */
  buildFrames(command: NormalizedCommand): Uint8Array[] | Promise<Uint8Array[]>
  /** 初始化帧(连接后发送;Tier 1 由配置生成,Tier 2 可选) */
  buildInitFrames?(): Uint8Array[] | Promise<Uint8Array[]>
  /** 停止帧(lastState 为各功能最近一次模式,供"强度归零、模式保留"策略使用;Tier 2 缺省回退为逐功能强度 0) */
  buildStopFrames?(lastState: Record<string, { mode?: number }>): Uint8Array[] | Promise<Uint8Array[]>
}

// ---- 校验(结构性:类型/能力/范围) ----

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export type ToyValidateResult
  = | { ok: true, event: DeviceEvent }
    | { ok: false, reason: string }

/**
 * 结构性校验 + 能力检查:function 必须在能力声明内,强度/模式/时长钳制到合法范围。
 * 超能力(未知功能)与类型错误直接拒绝;数值越界钳制(0-100 / 1..modeCount / 0..3600)。
 */
export function validateDeviceEvent(raw: unknown, caps: ToyCapabilities): ToyValidateResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '设备事件必须是 JSON 对象' }
  const o = raw as Record<string, unknown>
  if (typeof o.function !== 'string' || !o.function.trim()) return { ok: false, reason: '设备事件缺少 function' }
  const fn = caps.functions.find(f => f.id === o.function)
  if (!fn) return { ok: false, reason: `设备不支持功能「${o.function}」` }

  // 目标适配器(多适配器路由;缺省 = 当前连接设备)
  const adapter = typeof o.adapter === 'string' && o.adapter.trim() ? o.adapter.trim() : undefined

  if (typeof o.intensity !== 'number' || !Number.isFinite(o.intensity)) {
    return { ok: false, reason: `功能「${fn.name}」的强度必须是数字` }
  }
  const intensity = clamp(Math.round(o.intensity), 0, 100)

  let mode: number | undefined
  if (o.mode !== undefined) {
    if (typeof o.mode !== 'number' || !Number.isFinite(o.mode)) return { ok: false, reason: 'mode 必须是数字' }
    mode = clamp(Math.round(o.mode), 1, fn.modeCount ?? 1)
  }

  let duration: number | undefined
  if (o.duration !== undefined) {
    if (typeof o.duration !== 'number' || !Number.isFinite(o.duration)) return { ok: false, reason: 'duration 必须是数字' }
    duration = clamp(Math.round(o.duration), 0, 3600)
  }

  return {
    ok: true,
    event: {
      ...(adapter !== undefined ? { adapter } : {}),
      function: fn.id,
      intensity,
      ...(mode !== undefined ? { mode } : {}),
      ...(duration !== undefined ? { duration } : {})
    }
  }
}

// ---- 硬限制(用户设置;超限直接拒绝,不做静默降级,保证"AI 想越限也越不了") ----

export type ToyLimitResult
  = | { ok: true, event: DeviceEvent }
    | { ok: false, reason: string }

/** AI 来源命令额外受 aiEnabled 总开关约束(手动面板控制不检查此开关) */
/** 生效限制:只取按能力单独设置的值,未设置的能力初始默认 100 */
export function functionLimitOf(settings: ToySettings, fnId: string): { maxIntensity: number } {
  const f = settings.functionLimits?.[fnId]
  return { maxIntensity: f?.maxIntensity ?? DEFAULT_FUNCTION_MAX_INTENSITY }
}

export function checkHardLimits(event: DeviceEvent, settings: ToySettings, source: 'ai' | 'manual'): ToyLimitResult {
  if (source === 'ai') {
    if (!settings.aiEnabled) return { ok: false, reason: 'AI 设备控制总开关已关闭' }
    // 分能力单独启用:显式列表时只放行列表内的功能(缺省 = 全部允许)
    if (settings.aiEnabledFunctions != null && !settings.aiEnabledFunctions.includes(event.function)) {
      return { ok: false, reason: `功能「${event.function}」未开启 AI 控制,请在详细配置中启用` }
    }
    // 最大强度是 AI 的安全限制;手动控制直发设备能力全范围(0-100 由适配器钳制)
    const lim = functionLimitOf(settings, event.function)
    if (event.intensity > lim.maxIntensity) {
      return { ok: false, reason: `强度 ${event.intensity} 超过最大限制 ${lim.maxIntensity}` }
    }
  }
  // 时长上限为全局默认(安全链:到期自动归零),不做能力级区分
  if (settings.maxDuration > 0 && event.duration != null && event.duration > settings.maxDuration) {
    return { ok: false, reason: `时长 ${event.duration}s 超过最大限制 ${settings.maxDuration}s` }
  }
  return { ok: true, event }
}

// ---- Tier 1 帧引擎:token 模板 → 字节帧 ----

const TOKEN_SEQ = '[SEQ]'
const TOKEN_MODE1 = '[MODE1]'
const TOKEN_MODE2 = '[MODE2]'
const TOKEN_INTENSITY = '[INTENSITY]'
const TOKEN_MODE = '[MODE]'

function parseByteToken(tok: string): number | null {
  const s = tok.trim()
  if (/^0x/i.test(s)) {
    const v = parseInt(s.slice(2), 16)
    return Number.isFinite(v) && v >= 0 && v <= 255 ? v : null
  }
  if (/^\d+$/.test(s)) {
    const v = parseInt(s, 10)
    return v >= 0 && v <= 255 ? v : null
  }
  return null
}

interface FrameCtx {
  seq: number
  mode1?: number
  mode2?: number
  intensity: number
  mode?: number
}

/** 按模板构造一帧;token 无法解析时返回 null */
export function buildFrameFromTemplate(template: string[], ctx: FrameCtx): Uint8Array | null {
  const bytes = new Uint8Array(template.length)
  for (let i = 0; i < template.length; i++) {
    const tok = template[i] ?? ''
    let v: number | null | undefined
    if (tok === TOKEN_SEQ) v = ctx.seq
    else if (tok === TOKEN_MODE1) v = ctx.mode1
    else if (tok === TOKEN_MODE2) v = ctx.mode2
    else if (tok === TOKEN_INTENSITY) v = ctx.intensity
    else if (tok === TOKEN_MODE) v = ctx.mode
    else v = parseByteToken(tok)
    if (v == null || v < 0 || v > 255) return null
    bytes[i] = v
  }
  return bytes
}

function randomSeq(): number {
  return Math.floor(Math.random() * 256)
}

/** 构造单功能控制帧(强度/模式钳制到配置范围);功能未声明通道时返回 null */
export function buildProtocolControlFrame(
  proto: ToyProtocolConfig,
  fnId: ToyFunctionId,
  intensity: number,
  opts: { mode?: number, seq?: number } = {}
): Uint8Array | null {
  const fn = proto.functions[fnId]
  if (!fn) return null
  const [lo, hi] = proto.frame.intensityRange
  const [mL, mH] = proto.frame.modeRange ?? [1, 1]
  const mode = opts.mode != null ? clamp(Math.round(opts.mode), mL, mH) : 1
  const seq = opts.seq ?? (proto.frame.seqRandom === false ? 0 : randomSeq())
  return buildFrameFromTemplate(proto.frame.template, {
    seq,
    mode1: parseByteToken(String(fn.mode1)) ?? undefined,
    mode2: fn.mode2 != null ? parseByteToken(String(fn.mode2)) ?? undefined : undefined,
    intensity: clamp(Math.round(intensity), lo, hi),
    mode
  })
}

/** 初始化帧(连接后必发;Tier 1 由配置生成) */
export function buildProtocolInitFrame(proto: ToyProtocolConfig, seq?: number): Uint8Array | null {
  const init = proto.init
  if (!init) return null
  return buildFrameFromTemplate(init.frame, {
    seq: seq ?? (proto.frame.seqRandom === false ? 0 : randomSeq()),
    intensity: 0
  })
}

/** 停止帧:逐功能强度归零、模式保留(多数玩具的停止语义);seq 可选(测试固定用) */
export function buildProtocolStopFrames(
  proto: ToyProtocolConfig,
  lastState: Record<string, { mode?: number }> = {},
  opts: { seq?: number } = {}
): Uint8Array[] {
  const frames: Uint8Array[] = []
  for (const fnId of Object.keys(proto.functions)) {
    const f = buildProtocolControlFrame(proto, fnId, 0, { mode: lastState[fnId]?.mode, seq: opts.seq })
    if (f) frames.push(f)
  }
  return frames
}

/**
 * Tier 1 适配器工厂:由声明式协议配置自动生成 buildFrames/buildInitFrames/buildStopFrames,零代码。
 * 能力协商数据(capabilities)同样由配置推导:功能列表、强度范围、模式档位。
 */
export function createProtocolAdapter(
  proto: ToyProtocolConfig,
  manifest: Omit<ToyAdapterManifest, 'capabilities' | 'protocol'>
): ToyAdapter {
  const modeCount = proto.frame.modeRange?.[1] ?? 1
  const capabilities: ToyCapabilities = {
    perFunctionPair: proto.perFunctionPair ?? true,
    functions: Object.entries(proto.functions).map(([id, f]) => ({
      id,
      name: manifest.functionNames?.[id] ?? id,
      intensityRange: proto.frame.intensityRange,
      supportsMode: f.supportsMode ?? false,
      modeCount
    }))
  }
  return {
    manifest: { ...manifest, capabilities, protocol: proto },
    buildFrames: (cmd) => {
      const f = buildProtocolControlFrame(proto, cmd.function, cmd.intensity, { mode: cmd.mode })
      return f ? [f] : []
    },
    buildInitFrames: () => {
      const f = buildProtocolInitFrame(proto)
      return f ? [f] : []
    },
    buildStopFrames: lastState => buildProtocolStopFrames(proto, lastState)
  }
}

/** 字节帧 → 十六进制串(调试/演示用) */
export function framesToHex(frames: Uint8Array[]): string[] {
  return frames.map(f => Array.from(f).map(b => b.toString(16).padStart(2, '0')).join(' '))
}

// ---- 波浪模式(手动控制验证;引擎层能力,适配器不参与) ----

/**
 * 波浪的两种随机游走姿态:
 * - sweep 大幅缓慢波动:期望值在整个范围内随机并刻意避近,小步长慢速推进,抵达即换——大跨度缓慢扫动;
 * - flutter 一定范围快速上下波动:期望值在固定窗口中心 ±15% span 内随机,大步长快速逼近,抵达即换——局部快速起伏。
 * 到期换目标时 65% 概率切换姿态、35% 保持,时长随机,两种形态交替出现。
 */
export type WaveRegime = 'sweep' | 'flutter'

/** 一次波浪目标抽取的结果(姿态/期望值/步长/保持时长一次确定) */
export interface WavePick {
  regime: WaveRegime
  /** 期望值 */
  target: number
  /** 该姿态的单步上限(每 tick 至多移动这么多) */
  stepMax: number
  /** 目标保持时长 ms(到期后重新抽取;抵达目标也会提前重抽) */
  dwellMs: number
  /** flutter 姿态的波动窗口中心(固定窗口,结构上有界;sweep 无) */
  center?: number
}

function pickTargetFor(
  regime: WaveRegime,
  prev: number,
  range: [number, number],
  prevPick: WavePick | undefined,
  rng: () => number
): WavePick {
  const [lo, hi] = range
  const span = Math.max(1, hi - lo)
  if (regime === 'sweep') {
    // 大幅:全范围随机目标,但刻意与当前位置拉开距离(避免原地小动)
    let target = lo + rng() * span
    if (Math.abs(target - prev) < span / 3) {
      target = prev > lo + span / 2 ? lo + rng() * (span / 6) : hi - rng() * (span / 6)
    }
    return {
      regime,
      target: clamp(Math.round(target), lo, hi),
      stepMax: Math.max(2, Math.round(span / 16)),
      dwellMs: Math.round(6000 + rng() * 9000)
    }
  }
  // flutter:窗口中心固定(首次 = 当前位置),目标在 ±15% span 内随机,大步快速逼近
  const center = prevPick?.regime === 'flutter' ? (prevPick.center ?? prev) : prev
  return {
    regime,
    target: clamp(Math.round(center + (rng() * 2 - 1) * span * 0.15), lo, hi),
    stepMax: Math.max(4, Math.round(span / 10)),
    dwellMs: Math.round(1500 + rng() * 2500),
    center
  }
}

/**
 * 抽取下一个波浪目标。prevPick 为 undefined(首次)时随机定姿态;
 * 之后每次抽取 65% 概率切换姿态、35% 保持,保证两种形态都随机出现。
 * rng 可注入(测试用);目标始终落在 [lo, hi] 内。
 */
export function pickWaveTarget(
  prev: number,
  range: [number, number],
  prevPick: WavePick | undefined,
  rng: () => number = Math.random
): WavePick {
  const regime: WaveRegime = prevPick == null
    ? (rng() < 0.5 ? 'sweep' : 'flutter')
    : (rng() < 0.35 ? prevPick.regime : (prevPick.regime === 'sweep' ? 'flutter' : 'sweep'))
  return pickTargetFor(regime, prev, range, prevPick, rng)
}

/**
 * 抵达目标后保持当前姿态重抽目标(sweep 继续大跨度扫动;flutter 在窗口内换向),
 * 让波浪持续运动,不会"到位后停在原地小动"。窗口中心保持不变,flutter 不发散。
 */
export function repickWaveTarget(
  prev: number,
  range: [number, number],
  prevPick: WavePick,
  rng: () => number = Math.random
): WavePick {
  return pickTargetFor(prevPick.regime, prev, range, prevPick, rng)
}

// ---- 调教形态(波形生成;引擎层能力,适配器不参与) ----

/**
 * 调教形态:
 * - sine 正弦起伏:平滑周期波动(周期 periodSec 秒,振幅 amplitude%);
 * - pulse 脉冲节拍:周期内高电平占 duty 时长、其余 low(默认 0 = 停);
 * - sawtooth 锯齿爬升:周期内从低到高线性渐强,到顶骤降回起点;
 * - heartbeat 心跳双拍:每周期两次短促高电平(双连拍),其余 low;
 * - random 随机漫步:sweep 大幅缓慢 / flutter 局部快速 两种姿态随机交替(目标抽取由引擎维护);
 * - constant 恒定:保持 level(缺省 = 起始强度);
 * - auto 全随机:形态与参数都随机轮换(引擎每 autoSwitchMs 切换一次)。
 */
export type TrainPattern = 'sine' | 'pulse' | 'sawtooth' | 'heartbeat' | 'random' | 'constant' | 'auto'

/** 形态参数(均可选,带各自默认值;UI 暂不暴露,auto 模式自动随机) */
export interface TrainPatternParams {
  /** 周期秒(sine/pulse/sawtooth/heartbeat) */
  periodSec?: number
  /** 振幅百分比 0-100(sine) */
  amplitude?: number
  /** 高电平占比 0-1(pulse) */
  duty?: number
  /** 低电平强度 0-100,缺省 0 = 停(pulse/heartbeat) */
  low?: number
  /** 恒定强度(缺省 = 起始强度) */
  level?: number
}

/**
 * 确定性形态的实时强度(纯函数,按已运行秒数直接计算;rng 不参与)。
 * random/auto 由引擎的目标抽取与轮换逻辑处理,不在此计算。
 */
export function trainPatternValue(
  pattern: TrainPattern,
  elapsedSec: number,
  params: TrainPatternParams,
  range: [number, number]
): number {
  const [lo, hi] = range
  const span = Math.max(1, hi - lo)
  switch (pattern) {
    case 'sine': {
      const periodSec = params.periodSec ?? 10
      const amp = (params.amplitude ?? 100) / 100
      return clamp(Math.round((lo + hi) / 2 + (span / 2) * amp * Math.sin(2 * Math.PI * elapsedSec / periodSec)), lo, hi)
    }
    case 'pulse': {
      const periodSec = params.periodSec ?? 6
      const duty = params.duty ?? 0.4
      return (elapsedSec % periodSec) / periodSec < duty ? hi : (params.low ?? 0)
    }
    case 'sawtooth': {
      const periodSec = params.periodSec ?? 10
      return Math.round(lo + span * ((elapsedSec % periodSec) / periodSec))
    }
    case 'heartbeat': {
      const periodSec = params.periodSec ?? 4
      const phase = (elapsedSec % periodSec) / periodSec
      return phase < 0.08 || (phase >= 0.22 && phase < 0.3) ? hi : (params.low ?? 0)
    }
    case 'constant':
      return clamp(Math.round(params.level ?? 50), lo, hi)
    default:
      return 0
  }
}

/** auto 模式:随机抽一个具体形态(不含 auto 本身) */
export function randomTrainPattern(rng: () => number = Math.random): TrainPattern {
  const list: TrainPattern[] = ['sine', 'pulse', 'sawtooth', 'heartbeat', 'random', 'constant']
  const idx = Math.min(list.length - 1, Math.floor(rng() * list.length))
  return list[idx] ?? 'sine'
}

/** auto 模式:给形态随机一套参数 */
export function randomTrainParams(pattern: TrainPattern, range: [number, number], rng: () => number = Math.random): TrainPatternParams {
  const [lo, hi] = range
  const span = Math.max(1, hi - lo)
  switch (pattern) {
    case 'sine': return { periodSec: Math.round(6 + rng() * 8) }
    case 'pulse': return { periodSec: Math.round(4 + rng() * 4), duty: Math.round((0.3 + rng() * 0.2) * 100) / 100 }
    case 'sawtooth': return { periodSec: Math.round(6 + rng() * 8) }
    case 'heartbeat': return { periodSec: Math.round(3 + rng() * 3) }
    case 'constant': return { level: Math.round(lo + rng() * span) }
    default: return {}
  }
}

/**
 * 目标驱动的平滑步进:朝 target 收敛并在其附近徘徊。
 * - 离目标远:大步前进(stepMax 的 30%~100%,随机);
 * - 接近目标(|dist| ≤ stepMax):直接抵达 + 小幅抖动(徘徊感);
 * - 越界反弹(不钳制卡边界);始终落在范围内。rng 可注入(测试用)。
 */
export function stepToward(
  prev: number,
  target: number,
  range: [number, number],
  opts: { stepMax: number, wander?: number, rng?: () => number } = { stepMax: 8 }
): number {
  const { stepMax, wander = 0.3, rng = Math.random } = opts
  const [lo, hi] = range
  const dist = target - prev
  const approach = Math.sign(dist) * Math.max(1, Math.round(stepMax * (0.3 + rng() * 0.7)))
  const jitter = Math.round((rng() * 2 - 1) * stepMax * wander)
  let next = prev + (Math.abs(dist) > stepMax ? approach : approach * Math.max(0.2, Math.abs(dist) / stepMax)) + jitter
  if (next < lo) next = lo + (lo - next)
  if (next > hi) next = hi - (next - hi)
  return clamp(next, lo, hi)
}

// ---- 适配器 manifest 校验(导入玩家适配器时用) ----

export type ManifestValidateResult
  = | { ok: true, manifest: ToyAdapterManifest }
    | { ok: false, reason: string }

/**
 * 校验一份玩家提交的 manifest(Tier 1 需 protocol,或 Tier 2 需代码由调用方补充):
 * id/name/version 必填;protocol 存在时按 Tier 1 生成 capabilities;
 * 否则要求 capabilities.functions 非空(能力声明,供能力协商与界面展示)。
 */
export function validateAdapterManifest(raw: unknown): ManifestValidateResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'manifest 必须是 JSON 对象' }
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const version = typeof o.version === 'string' ? o.version.trim() : ''
  if (!id) return { ok: false, reason: 'manifest 缺少 id(稳定标识)' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, reason: 'id 只能包含小写字母/数字/连字符' }
  if (!name) return { ok: false, reason: 'manifest 缺少 name(适配器名称)' }
  if (!version) return { ok: false, reason: 'manifest 缺少 version(版本号)' }
  const scanNames = Array.isArray(o.scanNames) && o.scanNames.length
    ? o.scanNames.filter((s): s is string => typeof s === 'string' && !!s.trim()).map(s => s.trim())
    : undefined
  const functionNames = (() => {
    if (!o.functionNames || typeof o.functionNames !== 'object') return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.functionNames as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    }
    return Object.keys(out).length ? out : undefined
  })()

  const protocol = o.protocol && typeof o.protocol === 'object'
    ? validateProtocolConfig(o.protocol)
    : undefined
  if (o.protocol != null && !protocol) return { ok: false, reason: 'protocol 配置不合法(需 frame.template/intensityRange/functions)' }

  const capsRaw = o.capabilities as Record<string, unknown> | undefined
  if (!protocol) {
    const funcs = Array.isArray(capsRaw?.functions) ? capsRaw.functions : []
    if (!funcs.length) return { ok: false, reason: '适配器需要 protocol 声明式配置,或声明 capabilities.functions' }
    const functions = funcs.map((f, i) => {
      const fo = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>
      return {
        id: typeof fo.id === 'string' ? fo.id : `fn${i}`,
        name: typeof fo.name === 'string' ? fo.name : String(fo.id ?? `fn${i}`),
        intensityRange: Array.isArray(fo.intensityRange) ? fo.intensityRange as [number, number] : undefined,
        supportsMode: typeof fo.supportsMode === 'boolean' ? fo.supportsMode : false,
        modeCount: typeof fo.modeCount === 'number' ? fo.modeCount : undefined
      }
    })
    return {
      ok: true,
      manifest: {
        id, name, version, scanNames, functionNames,
        capabilities: { functions, perFunctionPair: capsRaw?.perFunctionPair !== false },
        protocol: undefined
      }
    }
  }

  return {
    ok: true,
    manifest: { id, name, version, scanNames, functionNames, protocol }
  }
}

/** 粗略校验 Tier 1 协议配置:帧模板/强度范围/功能表缺一不可 */
function validateProtocolConfig(raw: unknown): ToyProtocolConfig | null {
  const o = raw as Record<string, unknown>
  const frame = o.frame as Record<string, unknown> | undefined
  if (!frame || !Array.isArray(frame.template) || frame.template.length === 0) return null
  const intensityRange = Array.isArray(frame.intensityRange) && frame.intensityRange.length === 2
    ? frame.intensityRange as [number, number]
    : undefined
  if (!intensityRange) return null
  const functions = o.functions && typeof o.functions === 'object'
    ? Object.fromEntries(
      Object.entries(o.functions as Record<string, unknown>).filter(([, f]) => {
        const fo = f as Record<string, unknown> | null
        return !!fo && typeof fo === 'object' && (fo.mode1 != null || fo.mode2 != null)
      })
    ) as Record<string, { mode1: string | number, mode2?: string | number, supportsMode?: boolean }>
    : undefined
  if (!functions || !Object.keys(functions).length) return null
  return {
    gatt: (o.gatt && typeof o.gatt === 'object') ? o.gatt as ToyProtocolConfig['gatt'] : undefined,
    frame: {
      template: frame.template.filter((t): t is string => typeof t === 'string'),
      seqRandom: typeof frame.seqRandom === 'boolean' ? frame.seqRandom : true,
      intensityRange,
      modeRange: Array.isArray(frame.modeRange) && frame.modeRange.length === 2
        ? frame.modeRange as [number, number]
        : undefined
    },
    functions,
    init: (o.init && typeof o.init === 'object')
      ? {
          frame: Array.isArray((o.init as Record<string, unknown>).frame) ? (o.init as { frame: string[] }).frame : undefined,
          notifyFragments: typeof (o.init as Record<string, unknown>).notifyFragments === 'number' ? (o.init as { notifyFragments?: number }).notifyFragments : undefined,
          waitMs: typeof (o.init as Record<string, unknown>).waitMs === 'number' ? (o.init as { waitMs?: number }).waitMs : undefined
        } as ToyProtocolConfig['init']
      : undefined,
    perFunctionPair: typeof o.perFunctionPair === 'boolean' ? o.perFunctionPair : true
  }
}
