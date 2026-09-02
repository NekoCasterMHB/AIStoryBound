// app/toy/api.ts
// ToyApi 门面:所有控制都走这一个入口——
// 能力协商 → 结构性校验 → 硬限制(用户设置) → 适配器帧 → 传输写入;
// 附带计时自动停止、断连自动停止、紧急停止。
// 手动面板 / AI 回合(游戏页)/ 测试模态框共用,保证"AI 想越限也越不了"。
// 多连接架构:每个已启用插件可持有独立连接槽位(slot),state.connections 按 adapterId 分组,
// 波形/计时器/功能状态全部按连接隔离;指令经 raw.adapter 或 opts.targetId 路由到目标设备。
import { reactive } from 'vue'
import {
  DEFAULT_FUNCTION_MAX_INTENSITY,
  DEFAULT_TOY_SETTINGS,
  checkHardLimits,
  functionLimitOf,
  isAiFunctionEnabled,
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
  /** 目标适配器 id(多连接路由;缺省 = raw.adapter ?? 当前 active 连接) */
  targetId?: string
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

/** 单个连接的响应式状态(挂在 state.connections[adapterId]) */
export interface ToyConnectionState {
  connected: boolean
  adapterId: string
  adapterName: string
  deviceName: string | null
  /** 传输层设备 id(电量缓存等按此查询) */
  deviceId: string | null
  transportId: string | null
  functions: Record<string, ToyFunctionState>
  /** 自动控制会话进行中(AI 流式内联指令编排期;操作面板据此锁定手动控制) */
  autoActive: boolean
}

/** 内部连接槽位:响应式状态 + 执行上下文(适配器/传输/计时器),全部按连接隔离 */
interface ToySlot {
  state: ToyConnectionState
  adapter: ToyAdapter
  transport: ToyTransport
  unregisterDisconnect: (() => void) | null
  timers: Map<string, ReturnType<typeof setTimeout>>
  waveTimers: Map<string, ReturnType<typeof setInterval>>
  wavePrev: Map<string, number>
  waveTargets: Map<string, WavePick & { since: number }>
  waveRuns: Map<string, { auto: boolean, pattern: TrainPattern, params: TrainPatternParams, startedAt: number, switchAt?: number }>
  waveStopTimers: Map<string, ReturnType<typeof setTimeout>>
}

export interface ToyControllerState {
  /** 多连接:adapterId → 连接状态 */
  connections: Record<string, ToyConnectionState>
  /** 最近连接/操作的适配器(UI 默认聚焦;AI 指令无显式 adapter 时路由目标) */
  activeAdapterId: string | null
}

class ToyController {
  /** 响应式状态(面板/游戏页订阅;多连接按 adapterId 分组) */
  state = reactive<ToyControllerState>({
    connections: {},
    activeAdapterId: null
  })

  /** 执行上下文槽位(含计时器等非响应式成员;与 state.connections 一一对应) */
  private slots = new Map<string, ToySlot>()

  /** 是否至少有一个连接 */
  get connected(): boolean {
    return Object.keys(this.state.connections).length > 0
  }

  /** 全部已连接 adapterId */
  connectedIds(): string[] {
    return Object.keys(this.state.connections).filter(id => this.state.connections[id]?.connected)
  }

  /** 单个连接的响应式状态(未连接返回 undefined) */
  slotOf(adapterId: string): ToyConnectionState | undefined {
    return this.state.connections[adapterId]
  }

  /** 当前 active 连接的响应式状态(无 active 时取第一个已连接) */
  get activeSlot(): ToyConnectionState | undefined {
    const ids = this.connectedIds()
    if (this.state.activeAdapterId && this.state.connections[this.state.activeAdapterId]?.connected) {
      return this.state.connections[this.state.activeAdapterId]
    }
    const first = ids[0]
    return first ? this.state.connections[first] : undefined
  }

  /** 内部槽位(adapterId 缺省 = active;null 归一为 undefined) */
  private slotOfImpl(adapterId?: string | null): ToySlot | null {
    const id = adapterId ?? this.state.activeAdapterId ?? undefined
    if (!id) return null
    return this.slots.get(id) ?? null
  }

  /**
   * 连接:扫描 → 连接 → 发送初始化帧。每插件独立槽位,可同时连接多个适配器。
   * opts.device 为已授权设备时直连(免系统选择器,Web Bluetooth getDevices 列表点选);
   * 缺省走 transport.scan(Web Bluetooth 的系统选择器,必须在用户手势内调用)。
   */
  async connect(adapter: ToyAdapter, transport: ToyTransport, opts: { device?: ToyTransportDevice, waitInitMs?: number } = {}): Promise<ToyConnectResult> {
    const adapterId = adapter.manifest.id
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

      // 建槽(替换同 adapterId 旧连接:先清理)
      const old = this.slots.get(adapterId)
      if (old) this.teardownSlot(old)

      const connState: ToyConnectionState = reactive({
        connected: true,
        adapterId,
        adapterName: adapter.manifest.name,
        deviceName: device.name,
        deviceId: device.id,
        transportId: transport.id,
        functions: {},
        autoActive: false
      })
      const slot: ToySlot = {
        state: connState,
        adapter,
        transport,
        unregisterDisconnect: null,
        timers: new Map(),
        waveTimers: new Map(),
        wavePrev: new Map(),
        waveTargets: new Map(),
        waveRuns: new Map(),
        waveStopTimers: new Map()
      }
      slot.unregisterDisconnect = transport.onDisconnect(() => this.handleDisconnect(adapterId))
      this.state.connections[adapterId] = connState
      this.slots.set(adapterId, slot)
      this.state.activeAdapterId = adapterId
      return { ok: true }
    } catch (e) {
      // 连接失败清理半建槽
      this.slots.delete(adapterId)
      // reactive 对象删 key(Vue 3 原生支持,触发依赖更新)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.state.connections[adapterId]
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 执行一条语义命令(统一校验链;raw 允许为 AI 输出未经校验的 JSON)。
   * 目标路由:raw.adapter → opts.targetId → activeAdapterId;目标未连接 → 明确拒绝。
   */
  async execute(raw: unknown, opts: ToyExecuteOptions): Promise<ToyExecuteResult> {
    const probe = (typeof raw === 'object' && raw !== null ? raw as DeviceEvent : null)
    const adapterId = probe?.adapter ?? opts.targetId ?? this.state.activeAdapterId ?? undefined
    const slot = adapterId ? this.slots.get(adapterId) : null
    if (!slot || !slot.state.connected) {
      return { ok: false, reason: adapterId ? `目标设备「${adapterId}」未连接,请先连接` : '设备未连接' }
    }
    const caps = slot.adapter.manifest.capabilities ?? { functions: [] }
    const v = validateDeviceEvent(raw, caps)
    if (!v.ok) return v
    const event = v.event
    // 强制绑定目标(即使 raw 带了别的 adapter 也以本 slot 为准;多连接互不串台)
    event.adapter = slot.state.adapterId

    const limit = checkHardLimits(event, opts.settings, opts.source, caps, slot.state.adapterId)
    if (!limit.ok) return limit
    // 强度 0 且该功能调教中:直接停止调教(归零),避免波形循环与停止指令打架
    if (event.intensity === 0 && slot.waveTimers.has(event.function)) {
      this.stopWave(event.function, slot.state.adapterId)
      return { ok: true, event }
    }
    const frames = await slot.adapter.buildFrames(event)
    if (!frames.length) return { ok: false, reason: `适配器无法生成「${event.function}」指令帧` }
    try {
      for (const f of frames) await slot.transport.write(f)
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }

    // 状态与自动停止计时(duration 到期自动发停止帧)
    const prev = slot.state.functions[event.function]
    const nextState: ToyFunctionState = { ...(prev ?? {}), intensity: event.intensity, mode: event.mode ?? prev?.mode }
    if (event.duration != null) {
      nextState.activeUntil = Date.now() + event.duration * 1000
    } else {
      delete nextState.activeUntil
    }
    slot.state.functions[event.function] = nextState
    const old = slot.timers.get(event.function)
    if (old) clearTimeout(old)
    slot.timers.delete(event.function)
    if (event.duration != null && event.duration > 0) {
      slot.timers.set(event.function, setTimeout(() => {
        void this.stopFunction(event.function, slot.state.adapterId)
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
  async stopFunction(fn: string, adapterId?: string): Promise<void> {
    const slot = this.slotOfImpl(adapterId)
    if (!slot || !slot.state.connected) return
    const prev = slot.state.functions[fn]
    const event: DeviceEvent = { adapter: slot.state.adapterId, function: fn, intensity: 0, ...(prev?.mode != null ? { mode: prev.mode } : {}) }
    const frames = await slot.adapter.buildFrames(event)
    try {
      for (const f of frames) await slot.transport.write(f)
    } catch {
      // 停止失败不阻塞后续(断连场景由 handleDisconnect 兜底)
    }
    const t = slot.timers.get(fn)
    if (t) clearTimeout(t)
    slot.timers.delete(fn)
    if (slot.state.functions[fn]) {
      const prevState = slot.state.functions[fn]
      slot.state.functions[fn] = { ...(prevState.mode != null ? { mode: prevState.mode } : {}), intensity: 0 }
    }
  }

  /** 全停(按协议停止帧:各功能强度归零、模式保留)。adapterId 缺省 = 全部连接 */
  async stopAll(adapterId?: string): Promise<void> {
    const targets = adapterId
      ? [this.slotOfImpl(adapterId)].filter(Boolean) as ToySlot[]
      : [...this.slots.values()]
    for (const slot of targets) {
      if (!slot.state.connected) continue
      const lastState: Record<string, { mode?: number }> = {}
      for (const [fn, st] of Object.entries(slot.state.functions)) lastState[fn] = { mode: st.mode }
      const frames = await slot.adapter.buildStopFrames?.(lastState) ?? []
      try {
        for (const f of frames) await slot.transport.write(f)
      } catch {
        // 同上,断连场景由 handleDisconnect 兜底
      }
      for (const [fn, st] of Object.entries(slot.state.functions)) {
        if (st) slot.state.functions[fn] = { ...(st.mode != null ? { mode: st.mode } : {}), intensity: 0 }
      }
      for (const t of slot.timers.values()) clearTimeout(t)
      slot.timers.clear()
    }
  }

  /** 紧急停止 = 全停(最高优先级路径;不主动断开连接) */
  async emergencyStop(): Promise<void> {
    await this.stopAll()
  }

  // ---- 自动控制会话(游戏页流式内联指令编排期;面板锁定手动控制) ----

  /** 进入自动控制会话(目标连接缺省 = active) */
  beginAutoSession(adapterId?: string): void {
    const slot = this.slotOfImpl(adapterId)
    if (slot) slot.state.autoActive = true
  }

  /** 结束自动控制会话 */
  endAutoSession(adapterId?: string): void {
    const slot = this.slotOfImpl(adapterId)
    if (slot) slot.state.autoActive = false
  }

  // ---- 调教模式(引擎内称 wave):形态波形 + 随机漫步两种姿态(手动控制验证) ----

  /**
   * 启动调教模式:每 intervalMs 按形态生成强度。
   * adapterId 缺省 = active 连接;手动调教范围直达设备能力上限(不受 AI 最大强度限制)。
   */
  async startWave(
    fnId: string,
    range: [number, number],
    opts: { pattern?: TrainPattern, params?: TrainPatternParams, intervalMs?: number, autoSwitchMs?: number, settings?: ToySettings, rng?: () => number, duration?: number, adapterId?: string } = {}
  ): Promise<ToyExecuteResult> {
    const adapterId = opts.adapterId ?? this.state.activeAdapterId ?? undefined
    const slot = adapterId ? this.slots.get(adapterId) : null
    if (!slot || !slot.state.connected) {
      return { ok: false, reason: '设备未连接' }
    }
    const fn = (slot.adapter.manifest.capabilities?.functions ?? []).find(f => f.id === fnId)
    if (!fn) return { ok: false, reason: `设备不支持功能「${fnId}」` }
    const settings = opts.settings ?? DEFAULT_TOY_SETTINGS

    // 清理旧调教状态(不发停止帧)
    const oldTimer = slot.waveTimers.get(fnId)
    if (oldTimer) clearInterval(oldTimer)
    slot.waveTimers.delete(fnId)
    slot.wavePrev.delete(fnId)
    slot.waveTargets.delete(fnId)
    slot.waveRuns.delete(fnId)
    const oldSt = slot.state.functions[fnId]
    if (oldSt) {
      slot.state.functions[fnId] = {
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

    const prev = slot.state.functions[fnId]?.intensity ?? lo
    slot.wavePrev.set(fnId, prev)

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
    slot.waveRuns.set(fnId, {
      auto: requested === 'auto',
      pattern,
      params,
      startedAt: Date.now(),
      switchAt: autoSwitchMs != null ? Date.now() + autoSwitchMs : undefined
    })
    // 随机漫步预置首个目标(便于 waveRegimeOf 立即返回姿态)
    if (pattern === 'random') {
      slot.waveTargets.set(fnId, { ...pickWaveTarget(prev, [lo, hi], undefined, rng), since: Date.now() })
    }
    // 立即发起始值,再进入 tick
    void this.execute({ function: fnId, intensity: prev }, { source: 'manual', settings, targetId: adapterId })

    slot.waveTimers.set(fnId, setInterval(() => {
      const p = slot.wavePrev.get(fnId) ?? lo
      const now = Date.now()
      const run = slot.waveRuns.get(fnId)

      // auto:到期轮换到随机形态(随机参数;切到 constant 时从当前值起步,避免跳变)
      if (run?.auto && run.switchAt != null && now >= run.switchAt) {
        const next = randomTrainPattern(rng)
        slot.waveRuns.set(fnId, {
          auto: true,
          pattern: next,
          params: next === 'constant' ? { level: p } : randomTrainParams(next, [lo, hi], rng),
          startedAt: now,
          switchAt: now + (opts.autoSwitchMs ?? Math.round(8000 + (rng ?? Math.random)() * 7000))
        })
        slot.waveTargets.delete(fnId)
        return
      }

      let v: number
      if (run?.pattern === 'random') {
        // 随机漫步:期望值到期/抵达都重抽(持续运动,不会"到位后原地小动")
        const wt = slot.waveTargets.get(fnId)
        if (!wt) {
          slot.waveTargets.set(fnId, { ...pickWaveTarget(p, [lo, hi], undefined, rng), since: now })
        } else if (now - wt.since >= wt.dwellMs) {
          slot.waveTargets.set(fnId, { ...pickWaveTarget(p, [lo, hi], wt, rng), since: now })
        } else if (Math.abs(p - wt.target) <= wt.stepMax) {
          slot.waveTargets.set(fnId, { ...repickWaveTarget(p, [lo, hi], wt, rng), since: now })
        }
        const t = slot.waveTargets.get(fnId)
        if (!t) return
        v = stepToward(p, t.target, [lo, hi], { stepMax: t.stepMax })
      } else if (run) {
        // 确定性波形:按已运行时长直接计算
        v = trainPatternValue(run.pattern, (now - run.startedAt) / 1000, run.params, [lo, hi])
      } else {
        return
      }
      slot.wavePrev.set(fnId, v)
      void this.execute({ function: fnId, intensity: v }, { source: 'manual', settings, targetId: adapterId })
    }, intervalMs))

    const st = slot.state.functions[fnId]
    slot.state.functions[fnId] = { ...(st ?? { intensity: prev }), intensity: prev, wave: true }

    // 调教自动停止(带 duration 时;到时归零,手动调教 duration 省略 = 持续到手动停止)
    const stopT = slot.waveStopTimers.get(fnId)
    if (stopT) clearTimeout(stopT)
    slot.waveStopTimers.delete(fnId)
    if (opts.duration != null && opts.duration > 0) {
      slot.waveStopTimers.set(fnId, setTimeout(() => {
        this.stopWave(fnId, adapterId)
      }, opts.duration * 1000))
    }
    return { ok: true, event: { adapter: adapterId, function: fnId, intensity: prev } }
  }

  /**
   * AI 触发的调教([[wave:功能:形态[:时长]]]):与 AI 设备事件同门槛——
   * AI 总开关 + 分功能启用;强度范围钳制到 min(清单声明上限, 用户覆盖),绝不超限;
   * adapterId 缺省 = active 连接;duration 可选(到时自动停止调教)。
   */
  async startWaveForAI(fnId: string, pattern: unknown, duration?: number, settings?: ToySettings, adapterId?: string): Promise<ToyExecuteResult> {
    const id = adapterId ?? this.state.activeAdapterId ?? undefined
    const slot = id ? this.slots.get(id) : null
    if (!slot || !slot.state.connected) {
      return { ok: false, reason: '设备未连接' }
    }
    if (!isTrainPattern(pattern)) {
      return { ok: false, reason: `未知调教形态「${String(pattern)}」(正弦/脉冲/锯齿/心跳/漫步/恒定/全随机)` }
    }
    const caps = slot.adapter.manifest.capabilities ?? { functions: [] }
    const fn = caps.functions.find(f => f.id === fnId)
    if (!fn) return { ok: false, reason: `设备不支持功能「${fnId}」` }
    const s = settings ?? DEFAULT_TOY_SETTINGS
    if (!s.aiEnabled) return { ok: false, reason: 'AI 设备控制总开关已关闭' }
    if (!isAiFunctionEnabled(s, fnId, id)) {
      return { ok: false, reason: `功能「${fnId}」未开启 AI 控制,请在详细配置中启用` }
    }
    const declaredMax = fn.intensityRange?.[1] ?? DEFAULT_FUNCTION_MAX_INTENSITY
    const lim = functionLimitOf(s, fnId, declaredMax, id)
    return this.startWave(fnId, [0, lim.maxIntensity], { pattern, settings: s, duration, adapterId: id })
  }

  /** 停止调教(发停止帧归零;不停止其他功能)。adapterId 缺省 = active */
  stopWave(fnId: string, adapterId?: string): void {
    const slot = this.slotOfImpl(adapterId)
    if (!slot) return
    const t = slot.waveTimers.get(fnId)
    if (t) clearInterval(t)
    slot.waveTimers.delete(fnId)
    slot.wavePrev.delete(fnId)
    slot.waveTargets.delete(fnId)
    slot.waveRuns.delete(fnId)
    const stopT = slot.waveStopTimers.get(fnId)
    if (stopT) clearTimeout(stopT)
    slot.waveStopTimers.delete(fnId)
    const st = slot.state.functions[fnId]
    if (st) {
      slot.state.functions[fnId] = {
        ...(st.mode != null ? { mode: st.mode } : {}),
        intensity: st.intensity,
        wave: false
      }
    }
    void this.stopFunction(fnId, slot.state.adapterId)
  }

  /** 该功能调教是否进行中(以定时器存在性为准,不依赖可被重建的 state 字段) */
  isWaveActive(fnId: string, adapterId?: string): boolean {
    const slot = this.slotOfImpl(adapterId)
    return slot ? slot.waveTimers.has(fnId) : false
  }

  /** 当前调教形态(未在调教中为 null) */
  wavePatternOf(fnId: string, adapterId?: string): TrainPattern | null {
    const slot = this.slotOfImpl(adapterId)
    return slot?.waveRuns.get(fnId)?.pattern ?? null
  }

  /** 当前随机漫步姿态(非随机漫步或未在调教中为 null) */
  waveRegimeOf(fnId: string, adapterId?: string): WaveRegime | null {
    const slot = this.slotOfImpl(adapterId)
    return slot?.waveTargets.get(fnId)?.regime ?? null
  }

  /** 断开连接:adapterId 缺省 = 全部 */
  async disconnect(adapterId?: string): Promise<void> {
    if (adapterId) {
      const slot = this.slots.get(adapterId)
      if (slot) {
        await slot.transport.disconnect()
        this.teardownSlot(slot)
      }
      return
    }
    for (const slot of this.slots.values()) {
      await slot.transport.disconnect()
      this.teardownSlot(slot)
    }
  }

  /** 清空单个槽位(计时器/状态/连接) */
  private teardownSlot(slot: ToySlot): void {
    slot.unregisterDisconnect?.()
    slot.unregisterDisconnect = null
    for (const t of slot.timers.values()) clearTimeout(t)
    slot.timers.clear()
    for (const t of slot.waveTimers.values()) clearInterval(t)
    slot.waveTimers.clear()
    for (const t of slot.waveStopTimers.values()) clearTimeout(t)
    slot.waveStopTimers.clear()
    slot.wavePrev.clear()
    slot.waveTargets.clear()
    slot.waveRuns.clear()
    this.slots.delete(slot.state.adapterId)
    // reactive 对象删 key(Vue 3 原生支持,触发依赖更新)
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.state.connections[slot.state.adapterId]
    if (this.state.activeAdapterId === slot.state.adapterId) this.state.activeAdapterId = null
  }

  /** 设备侧掉线(传输 onDisconnect 回调) */
  private handleDisconnect(adapterId: string): void {
    const slot = this.slots.get(adapterId)
    if (slot) this.teardownSlot(slot)
  }
}

/** 全局单例(页面/游戏回合共用同一连接池) */
export const toyController = new ToyController()

/**
 * 功能实时状态展示(纯函数):强度与「距自动停止剩余秒数」。
 * adapterId 必填(多连接下状态按连接隔离)。返回 remainingSec 只在「强度 > 0 且未到期」时为剩余秒数。
 */
export function toyFnStatus(adapterId: string, fnId: string, now = Date.now()): { intensity: number, remainingSec: number } {
  const st = toyController.slotOf(adapterId)?.functions[fnId]
  if (!st) return { intensity: 0, remainingSec: 0 }
  const remaining = st.activeUntil ? Math.max(0, Math.ceil((st.activeUntil - now) / 1000)) : 0
  return { intensity: st.intensity, remainingSec: st.intensity > 0 && remaining > 0 ? remaining : 0 }
}
