// app/toy/api.ts
// ToyApi 门面:所有控制都走这一个入口——
// 能力协商 → 结构性校验 → 硬限制(用户设置) → 冷却 → 适配器帧 → 传输写入;
// 附带计时自动停止、断连自动停止、紧急停止。
// 手动面板 / AI 回合(游戏页)/ 未来 MCP 共用,保证"AI 想越限也越不了"。
import { reactive } from 'vue'
import {
  DEFAULT_FUNCTION_MAX_INTENSITY,
  DEFAULT_TOY_SETTINGS,
  checkHardLimits,
  functionLimitOf,
  isTrainPattern,
  pickWaveTarget,
  randomTrainParams,
  randomTrainPattern,
  repickWaveTarget,
  stepToward,
  trainPatternValue,
  validateDeviceEvent
} from '#shared/toy'
import type { DeviceEvent, ToyAdapter, ToySettings, TrainPattern, TrainPatternParams, WavePick, WaveRegime } from '#shared/toy'
import type { ToyTransport, ToyTransportDevice } from './transports/transport'

export type ToyExecuteResult
  = | { ok: true, event: DeviceEvent }
    | { ok: false, reason: string }

export interface ToyExecuteOptions {
  source: 'ai' | 'manual'
  settings: ToySettings
}

export type ToyConnectResult = { ok: true } | { ok: false, reason: string }

/** 单功能实时状态(面板展示用:命令了什么就是什么,协议无状态回读) */
export interface ToyFunctionState {
  intensity: number
  mode?: number
  /** 自动停止的到期时间戳(有 duration 时) */
  activeUntil?: number
  /** 波浪模式进行中(手动控制验证用) */
  wave?: boolean
}

export interface ToyControllerState {
  connected: boolean
  adapterId: string | null
  adapterName: string | null
  deviceName: string | null
  /** 传输层设备 id(电量缓存等按此查询) */
  deviceId: string | null
  transportId: string | null
  functions: Record<string, ToyFunctionState>
  /** 自动控制会话进行中(AI 流式内联指令编排期;操作面板据此锁定手动控制) */
  autoActive: boolean
}

class ToyController {
  /** 响应式状态(面板/游戏页订阅) */
  state = reactive<ToyControllerState>({
    connected: false,
    adapterId: null,
    adapterName: null,
    deviceName: null,
    deviceId: null,
    transportId: null,
    functions: {},
    autoActive: false
  })

  private adapter: ToyAdapter | null = null
  private transport: ToyTransport | null = null
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private unregisterDisconnect: (() => void) | null = null
  /** 波浪模式:每 tick 用随机游走生成新强度并发送 */
  private waveTimers = new Map<string, ReturnType<typeof setInterval>>()
  private wavePrev = new Map<string, number>()
  /** 调教自动停止计时器(AI [[wave:...:时长]] 用;到时 stopWave) */
  private waveStopTimers = new Map<string, ReturnType<typeof setTimeout>>()

  get connected(): boolean {
    return this.state.connected
  }

  get connectedAdapter(): ToyAdapter | null {
    return this.adapter
  }

  /**
   * 连接:扫描 → 连接 → 发送初始化帧。
   * opts.device 为已授权设备时直连(免系统选择器,Web Bluetooth getDevices 列表点选);
   * 缺省走 transport.scan(Web Bluetooth 的系统选择器,必须在用户手势内调用)。
   */
  async connect(adapter: ToyAdapter, transport: ToyTransport, opts: { device?: ToyTransportDevice, waitInitMs?: number } = {}): Promise<ToyConnectResult> {
    try {
      // Tier 1 连接参数在 manifest.protocol.gatt;Tier 2 代码适配器在 manifest.gatt
      const gatt = adapter.manifest.protocol?.gatt ?? adapter.manifest.gatt
      if (!gatt) return { ok: false, reason: '适配器缺少 GATT 配置,无法连接' }
      const battery = adapter.manifest.protocol?.battery ?? adapter.manifest.battery
      const device = opts.device ?? (await transport.scan(adapter.manifest.scanNames, gatt, battery))[0]
      if (!device) return { ok: false, reason: '没有发现可连接的设备' }
      await transport.connect(device, gatt, battery)

      // 初始化帧(如啵啵贝的 [SEQ] 01 00 01 00 C8 11 01),等设备回配置分片后才可下发控制
      const initFrames = await adapter.buildInitFrames?.() ?? []
      for (const f of initFrames) await transport.write(f)
      const waitMs = opts.waitInitMs ?? adapter.manifest.protocol?.init?.waitMs ?? 0
      if (waitMs > 0 && initFrames.length > 0) await new Promise(r => setTimeout(r, waitMs))

      this.adapter = adapter
      this.transport = transport
      this.state.connected = true
      this.state.adapterId = adapter.manifest.id
      this.state.adapterName = adapter.manifest.name
      this.state.deviceName = device.name
      this.state.deviceId = device.id
      this.state.transportId = transport.id
      this.state.functions = {}

      this.unregisterDisconnect = transport.onDisconnect(() => this.handleDisconnect())
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 执行一条语义命令(统一校验链;raw 允许为 AI 输出未经校验的 JSON)。
   * 目标适配器路由:event.adapter 缺省 = 当前连接设备;显式指定其他适配器 → 拒绝(未连接)。
   * 多适配器"启用"是可选操作对象,连接是单槽位;AI 按剧情选择能力,未连接目标会被明确拒绝。
   */
  async execute(raw: unknown, opts: ToyExecuteOptions): Promise<ToyExecuteResult> {
    if (!this.state.connected || !this.adapter || !this.transport) {
      return { ok: false, reason: '设备未连接' }
    }
    const caps = this.adapter.manifest.capabilities ?? { functions: [] }
    const v = validateDeviceEvent(raw, caps)
    if (!v.ok) return v
    const event = v.event

    // 路由:指定了其他适配器 → 拒绝(单连接槽位,需要先切换连接)
    if (event.adapter != null && event.adapter !== this.adapter.manifest.id) {
      return {
        ok: false,
        reason: `目标设备「${event.adapter}」未连接(当前连接:${this.adapter.manifest.id});请先在设备面板/详细配置中切换连接`
      }
    }

    const limit = checkHardLimits(event, opts.settings, opts.source, caps)
    if (!limit.ok) return limit
    // 强度 0 且该功能调教中:直接停止调教(归零),避免波形循环与停止指令打架
    if (event.intensity === 0 && this.waveTimers.has(event.function)) {
      this.stopWave(event.function)
      return { ok: true, event }
    }
    const frames = await this.adapter.buildFrames(event)
    if (!frames.length) return { ok: false, reason: `适配器无法生成「${event.function}」指令帧` }
    try {
      for (const f of frames) await this.transport.write(f)
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }

    // 状态与自动停止计时(duration 到期自动发停止帧)
    // 保留 prev 的扩展字段(如 wave 波浪标记),避免被重建覆盖;duration 缺省时清除旧的 activeUntil
    const prev = this.state.functions[event.function]
    const nextState: ToyFunctionState = { ...(prev ?? {}), intensity: event.intensity, mode: event.mode ?? prev?.mode }
    if (event.duration != null) {
      nextState.activeUntil = Date.now() + event.duration * 1000
    } else {
      delete nextState.activeUntil
    }
    this.state.functions[event.function] = nextState
    const old = this.timers.get(event.function)
    if (old) clearTimeout(old)
    this.timers.delete(event.function)
    if (event.duration != null && event.duration > 0) {
      this.timers.set(event.function, setTimeout(() => {
        void this.stopFunction(event.function)
      }, event.duration * 1000))
    }
    return { ok: true, event }
  }

  /** 批量执行(AI 回合输出;逐条返回结果,不中断) */
  async executeEvents(rawEvents: unknown[], opts: ToyExecuteOptions): Promise<ToyExecuteResult[]> {
    const results: ToyExecuteResult[] = []
    for (const raw of rawEvents) {
      results.push(await this.execute(raw, opts))
    }
    return results
  }

  /** 停止单功能(强度归零、模式保留;绕过冷却但不绕过连接检查) */
  async stopFunction(fn: string): Promise<void> {
    if (!this.state.connected || !this.adapter || !this.transport) return
    const prev = this.state.functions[fn]
    const event: DeviceEvent = { function: fn, intensity: 0, ...(prev?.mode != null ? { mode: prev.mode } : {}) }
    const frames = await this.adapter.buildFrames(event)
    try {
      for (const f of frames) await this.transport.write(f)
    } catch {
      // 停止失败不阻塞后续(断连场景由 handleDisconnect 兜底)
    }
    const t = this.timers.get(fn)
    if (t) clearTimeout(t)
    this.timers.delete(fn)
    if (this.state.functions[fn]) {
      const prevState = this.state.functions[fn]
      this.state.functions[fn] = { ...(prevState.mode != null ? { mode: prevState.mode } : {}), intensity: 0 }
    }
  }

  /** 全停(按协议停止帧:各功能强度归零、模式保留) */
  async stopAll(): Promise<void> {
    if (!this.state.connected || !this.adapter || !this.transport) return
    const lastState: Record<string, { mode?: number }> = {}
    for (const [fn, st] of Object.entries(this.state.functions)) lastState[fn] = { mode: st.mode }
    const frames = await this.adapter.buildStopFrames?.(lastState) ?? []
    try {
      for (const f of frames) await this.transport.write(f)
    } catch {
      // 同上,断连场景由 handleDisconnect 兜底
    }
    for (const [fn, st] of Object.entries(this.state.functions)) {
      if (st) this.state.functions[fn] = { ...(st.mode != null ? { mode: st.mode } : {}), intensity: 0 }
    }
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** 紧急停止 = 全停(最高优先级路径;不主动断开连接) */
  async emergencyStop(): Promise<void> {
    await this.stopAll()
  }

  // ---- 自动控制会话(游戏页流式内联指令编排期;面板锁定手动控制) ----

  /** 进入自动控制会话(第一条 AI 流式指令执行时调用) */
  beginAutoSession(): void {
    this.state.autoActive = true
  }

  /** 结束自动控制会话(回合流式收尾/flush 完成后调用,手动恢复可用) */
  endAutoSession(): void {
    this.state.autoActive = false
  }

  // ---- 调教模式(引擎内称 wave):形态波形 + 随机漫步两种姿态(手动控制验证) ----

  /** 调教运行态:当前形态/参数/起始时刻;auto 模式(auto=true)每 switchAt 轮换形态 */
  private waveRuns = new Map<string, { auto: boolean, pattern: TrainPattern, params: TrainPatternParams, startedAt: number, switchAt?: number }>()
  /** 随机漫步目标:pickWaveTarget 抽取(到期/抵达都重抽);since = 目标开始时刻 */
  private waveTargets = new Map<string, WavePick & { since: number }>()

  /**
   * 启动调教模式:每 intervalMs 按形态生成强度——
   * - 确定性形态(sine/pulse/sawtooth/heartbeat/constant):按已运行时长直接计算波形;
   * - random 随机漫步:期望值按姿态随机交替抽取(sweep 大幅缓慢 / flutter 局部快速),抵达立即重抽;
   * - auto 全随机:先随机定一个形态与参数,每 autoSwitchMs(默认 8-15s)再轮换一次。
   * 手动调教范围直达设备能力上限(不受 AI 最大强度限制);重新启动时只清理旧调教状态,不发停止帧。
   */
  async startWave(
    fnId: string,
    range: [number, number],
    opts: { pattern?: TrainPattern, params?: TrainPatternParams, intervalMs?: number, autoSwitchMs?: number, settings?: ToySettings, rng?: () => number, duration?: number } = {}
  ): Promise<ToyExecuteResult> {
    if (!this.state.connected || !this.adapter || !this.transport) {
      return { ok: false, reason: '设备未连接' }
    }
    const fn = (this.adapter.manifest.capabilities?.functions ?? []).find(f => f.id === fnId)
    if (!fn) return { ok: false, reason: `设备不支持功能「${fnId}」` }
    const settings = opts.settings ?? DEFAULT_TOY_SETTINGS

    // 清理旧调教状态(不发停止帧)
    const oldTimer = this.waveTimers.get(fnId)
    if (oldTimer) clearInterval(oldTimer)
    this.waveTimers.delete(fnId)
    this.wavePrev.delete(fnId)
    this.waveTargets.delete(fnId)
    this.waveRuns.delete(fnId)
    const oldSt = this.state.functions[fnId]
    if (oldSt) {
      this.state.functions[fnId] = {
        ...(oldSt.mode != null ? { mode: oldSt.mode } : {}),
        intensity: oldSt.intensity,
        wave: false
      }
    }

    // 手动调教不受 AI 强度上限约束,直接用调用方范围(帧级强度仍由适配器能力范围钳制)
    const lo = Math.max(0, range[0])
    const hi = Math.max(lo, range[1])
    const intervalMs = opts.intervalMs ?? 300
    const rng = opts.rng

    const prev = this.state.functions[fnId]?.intensity ?? lo
    this.wavePrev.set(fnId, prev)

    // 解析初始形态:auto 立即抽一个具体形态(避免开始阶段空转);constant 的 level 缺省 = 起始强度
    const requested = opts.pattern ?? 'random'
    let pattern: TrainPattern = requested
    let params: TrainPatternParams = { ...(opts.params ?? {}) }
    if (requested === 'auto') {
      pattern = randomTrainPattern(rng)
      params = pattern === 'constant' ? { level: prev } : randomTrainParams(pattern, [lo, hi], rng)
    }
    if (pattern === 'constant' && params.level == null) params.level = prev
    const autoSwitchMs = requested === 'auto'
      ? (opts.autoSwitchMs ?? Math.round(8000 + (rng ?? Math.random)() * 7000))
      : undefined
    this.waveRuns.set(fnId, {
      auto: requested === 'auto',
      pattern,
      params,
      startedAt: Date.now(),
      switchAt: autoSwitchMs != null ? Date.now() + autoSwitchMs : undefined
    })
    // 随机漫步预置首个目标(便于 waveRegimeOf 立即返回姿态)
    if (pattern === 'random') {
      this.waveTargets.set(fnId, { ...pickWaveTarget(prev, [lo, hi], undefined, rng), since: Date.now() })
    }
    // 立即发起始值,再进入 tick
    void this.execute({ function: fnId, intensity: prev }, { source: 'manual', settings })

    this.waveTimers.set(fnId, setInterval(() => {
      const p = this.wavePrev.get(fnId) ?? lo
      const now = Date.now()
      const run = this.waveRuns.get(fnId)

      // auto:到期轮换到随机形态(随机参数;切到 constant 时从当前值起步,避免跳变)
      if (run?.auto && run.switchAt != null && now >= run.switchAt) {
        const next = randomTrainPattern(rng)
        this.waveRuns.set(fnId, {
          auto: true,
          pattern: next,
          params: next === 'constant' ? { level: p } : randomTrainParams(next, [lo, hi], rng),
          startedAt: now,
          switchAt: now + (opts.autoSwitchMs ?? Math.round(8000 + (rng ?? Math.random)() * 7000))
        })
        this.waveTargets.delete(fnId)
        return
      }

      let v: number
      if (run?.pattern === 'random') {
        // 随机漫步:期望值到期/抵达都重抽(持续运动,不会"到位后原地小动")
        const wt = this.waveTargets.get(fnId)
        if (!wt) {
          this.waveTargets.set(fnId, { ...pickWaveTarget(p, [lo, hi], undefined, rng), since: now })
        } else if (now - wt.since >= wt.dwellMs) {
          this.waveTargets.set(fnId, { ...pickWaveTarget(p, [lo, hi], wt, rng), since: now })
        } else if (Math.abs(p - wt.target) <= wt.stepMax) {
          this.waveTargets.set(fnId, { ...repickWaveTarget(p, [lo, hi], wt, rng), since: now })
        }
        const t = this.waveTargets.get(fnId)
        if (!t) return
        v = stepToward(p, t.target, [lo, hi], { stepMax: t.stepMax })
      } else if (run) {
        // 确定性波形:按已运行时长直接计算
        v = trainPatternValue(run.pattern, (now - run.startedAt) / 1000, run.params, [lo, hi])
      } else {
        return
      }
      this.wavePrev.set(fnId, v)
      void this.execute({ function: fnId, intensity: v }, { source: 'manual', settings })
    }, intervalMs))

    const st = this.state.functions[fnId]
    this.state.functions[fnId] = { ...(st ?? { intensity: prev }), intensity: prev, wave: true }

    // 调教自动停止(带 duration 时;到时归零,手动调教 duration 省略 = 持续到手动停止)
    const stopT = this.waveStopTimers.get(fnId)
    if (stopT) clearTimeout(stopT)
    this.waveStopTimers.delete(fnId)
    if (opts.duration != null && opts.duration > 0) {
      this.waveStopTimers.set(fnId, setTimeout(() => {
        this.stopWave(fnId)
      }, opts.duration * 1000))
    }
    return { ok: true, event: { function: fnId, intensity: prev } }
  }

  /**
   * AI 触发的调教([[wave:功能:形态[:时长]]]):与 AI 设备事件同门槛——
   * AI 总开关 + 分功能启用;强度范围钳制到 min(清单声明上限, 用户覆盖),绝不超限;
   * duration 可选(到时自动停止调教)。手动面板的调教不走此入口(直接 startWave,直达能力范围)。
   */
  async startWaveForAI(fnId: string, pattern: unknown, duration?: number, settings?: ToySettings): Promise<ToyExecuteResult> {
    if (!this.state.connected || !this.adapter || !this.transport) {
      return { ok: false, reason: '设备未连接' }
    }
    if (!isTrainPattern(pattern)) {
      return { ok: false, reason: `未知调教形态「${String(pattern)}」(正弦/脉冲/锯齿/心跳/漫步/恒定/全随机)` }
    }
    const caps = this.adapter.manifest.capabilities ?? { functions: [] }
    const fn = caps.functions.find(f => f.id === fnId)
    if (!fn) return { ok: false, reason: `设备不支持功能「${fnId}」` }
    const s = settings ?? DEFAULT_TOY_SETTINGS
    if (!s.aiEnabled) return { ok: false, reason: 'AI 设备控制总开关已关闭' }
    if (s.aiEnabledFunctions != null && !s.aiEnabledFunctions.includes(fnId)) {
      return { ok: false, reason: `功能「${fnId}」未开启 AI 控制,请在详细配置中启用` }
    }
    const declaredMax = fn.intensityRange?.[1] ?? DEFAULT_FUNCTION_MAX_INTENSITY
    const lim = functionLimitOf(s, fnId, declaredMax)
    return this.startWave(fnId, [0, lim.maxIntensity], { pattern, settings: s, duration })
  }

  /** 停止调教(发停止帧归零;不停止其他功能) */
  stopWave(fnId: string): void {
    const t = this.waveTimers.get(fnId)
    if (t) clearInterval(t)
    this.waveTimers.delete(fnId)
    this.wavePrev.delete(fnId)
    this.waveTargets.delete(fnId)
    this.waveRuns.delete(fnId)
    const stopT = this.waveStopTimers.get(fnId)
    if (stopT) clearTimeout(stopT)
    this.waveStopTimers.delete(fnId)
    const st = this.state.functions[fnId]
    if (st) {
      this.state.functions[fnId] = {
        ...(st.mode != null ? { mode: st.mode } : {}),
        intensity: st.intensity,
        wave: false
      }
    }
    void this.stopFunction(fnId)
  }

  /** 该功能调教是否进行中(以定时器存在性为准,不依赖可被重建的 state 字段) */
  isWaveActive(fnId: string): boolean {
    return this.waveTimers.has(fnId)
  }

  /** 当前调教形态(sine/pulse/sawtooth/heartbeat/random/constant;auto 显示当前已解析的形态;未在调教中为 null) */
  wavePatternOf(fnId: string): TrainPattern | null {
    return this.waveRuns.get(fnId)?.pattern ?? null
  }

  /** 当前随机漫步姿态(sweep 大幅缓慢波动 / flutter 局部快速起伏;非随机漫步或未在调教中为 null) */
  waveRegimeOf(fnId: string): WaveRegime | null {
    return this.waveTargets.get(fnId)?.regime ?? null
  }

  async disconnect(): Promise<void> {
    await this.transport?.disconnect()
    this.handleDisconnect()
  }

  private handleDisconnect(): void {
    this.unregisterDisconnect?.()
    this.unregisterDisconnect = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const t of this.waveTimers.values()) clearInterval(t)
    this.waveTimers.clear()
    for (const t of this.waveStopTimers.values()) clearTimeout(t)
    this.waveStopTimers.clear()
    this.wavePrev.clear()
    this.waveTargets.clear()
    this.waveRuns.clear()
    this.state.connected = false
    this.state.functions = {}
    this.state.autoActive = false
    this.state.deviceId = null
    this.adapter = null
    this.transport = null
  }
}

/** 全局单例(页面/游戏回合共用同一连接与状态) */
export const toyController = new ToyController()

/**
 * 功能实时状态展示(纯函数):强度与「距自动停止剩余秒数」。
 * activeUntil 是计划自动停止时间:期间设备仍在运行(未停),到点由计时器发停止帧归零。
 * 返回 remainingSec 只在「强度 > 0 且未到期」时为剩余秒数,其余为 0(含到期/手动停止后)。
 */
export function toyFnStatus(fnId: string, now = Date.now()): { intensity: number, remainingSec: number } {
  const st = toyController.state.functions[fnId]
  if (!st) return { intensity: 0, remainingSec: 0 }
  const remaining = st.activeUntil ? Math.max(0, Math.ceil((st.activeUntil - now) / 1000)) : 0
  return { intensity: st.intensity, remainingSec: st.intensity > 0 && remaining > 0 ? remaining : 0 }
}
