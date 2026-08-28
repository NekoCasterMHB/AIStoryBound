// shared/plugin.ts
// 通用插件能力描述系统(平台强制格式,纯 TS 零 IO,浏览器/服务器/Node 共用)。
// 清单(PluginDescriptor)→ 分析器(校验 + 归一化,无任何隐式推导)→ PluginSpec。
// PluginSpec 是动态控制 UI 渲染与 AI 能力编译的唯一输入;
// 玩具运行时由 adapter-loader 桥接回 ToyAdapter(复用 Tier 1 帧引擎 / Tier 2 沙箱 / 硬限制)。
// 强制规则:capabilities 必须显式声明(含每能力强度上限),缺失必填字段导入被拒并给出缺项。
import { validateProtocolConfig } from './toy'
import type { ToyBatterySpec, ToyCapabilities, ToyGattParams, ToyProtocolConfig } from './toy'

// ---- 清单类型(平台强制格式) ----

/** 参数定义:三种类型(int/float、enum、bool) */
export type ParamDef
  = | { key: string, type: 'int' | 'float', min?: number, max?: number, step?: number, unit?: string, default?: number, required?: boolean, description?: string }
    | { key: string, type: 'enum', values: { value: string | number, label: string }[], default?: string | number, description?: string }
    | { key: string, type: 'bool', default?: boolean, description?: string }

/** AI 可调用能力(显式必填;intensity 参数的 min/max 即每能力强度上限声明) */
export interface CapabilityDef {
  id: string
  name: string
  /** AI 提示词:什么情节用、参数怎么填 */
  description: string
  params: ParamDef[]
}

/** 控制面板布局(缺省由平台按 capabilities 生成默认布局) */
export interface UiSchema {
  groups: UiGroup[]
}

export interface UiGroup {
  id: string
  title: string
  controls: ControlDef[]
}

/** 控件绑定:指向某个能力的某个参数 */
export interface ControlBind {
  capability: string
  param: string
}

/** 控件六种:slider 滑块 / stepper 档位按钮组 / select 下拉 / toggle 开关 / action 一键动作 / display 只读状态 */
export type ControlDef
  = | { type: 'slider', bind: ControlBind, label?: string, min?: number, max?: number, step?: number }
    | { type: 'stepper', bind: ControlBind, values: { label: string, value: string | number }[] }
    | { type: 'select', bind: ControlBind, options?: { label: string, value: string | number }[] }
    | { type: 'toggle', bind: ControlBind, label?: string }
    | { type: 'action', capability: string, params: Record<string, string | number | boolean>, label: string }
    | { type: 'display', bind: ControlBind, label?: string }

/** 执行后端声明 */
export type PluginRuntime
  = | { type: 'toy-protocol', scanNames?: string[], protocol: ToyProtocolConfig }
    | { type: 'toy-code', scanNames?: string[], gatt: ToyGattParams, battery?: ToyBatterySpec }
    | { type: 'none' }

/** 平台强制格式清单(唯一导入格式) */
export interface PluginDescriptor {
  id: string
  name: string
  version: string
  icon?: string
  description?: string
  runtime?: PluginRuntime
  capabilities?: CapabilityDef[]
  ui?: UiSchema
}

/** 分析后的统一规格:UI 渲染与 AI 编译的唯一输入 */
export interface PluginSpec {
  descriptor: PluginDescriptor
  capabilities: CapabilityDef[]
  uiSchema: UiSchema
  runtime: PluginRuntime
}

// ---- 能力辅助(参数提取) ----

/** 能力的强度参数(int/float;0=停止,min 恒为 0) */
export function capabilityIntensityParam(cap: CapabilityDef): Extract<ParamDef, { type: 'int' | 'float' }> | undefined {
  return cap.params.find(p => p.key === 'intensity' && (p.type === 'int' || p.type === 'float')) as
    | Extract<ParamDef, { type: 'int' | 'float' }> | undefined
}

/** 能力的模式参数(enum 档位) */
export function capabilityModeParam(cap: CapabilityDef): Extract<ParamDef, { type: 'enum' }> | undefined {
  return cap.params.find(p => p.key === 'mode' && p.type === 'enum') as
    | Extract<ParamDef, { type: 'enum' }> | undefined
}

/** 能力的强度范围(未声明回退 [0,100]) */
export function capabilityIntensityRange(cap: CapabilityDef): [number, number] {
  const p = capabilityIntensityParam(cap)
  return p ? [p.min ?? 0, p.max ?? 100] : [0, 100]
}

/** 能力的模式档位数(无模式 = 1) */
export function capabilityModeCount(cap: CapabilityDef): number {
  const p = capabilityModeParam(cap)
  return p ? p.values.length : 1
}

// ---- 默认 UI 生成(平台渲染行为,非清单推导) ----

/** 时长档位(0=不限;单事件 duration 自动停止) */
const DEFAULT_DURATION_STEPS: { label: string, value: number }[] = [
  { label: '不限', value: 0 },
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
  { label: '180s', value: 180 },
  { label: '300s', value: 300 }
]

/** 缺省按 capabilities 生成默认布局:每能力一组 = 强度滑块 + 模式档位 + 时长档位 */
export function defaultUiSchema(capabilities: CapabilityDef[]): UiSchema {
  const groups: UiGroup[] = capabilities.map((cap) => {
    const controls: ControlDef[] = []
    if (capabilityIntensityParam(cap)) {
      const range = capabilityIntensityRange(cap)
      controls.push({ type: 'slider', bind: { capability: cap.id, param: 'intensity' }, min: range[0], max: range[1] })
    }
    const mode = capabilityModeParam(cap)
    if (mode) controls.push({ type: 'stepper', bind: { capability: cap.id, param: 'mode' }, values: mode.values })
    if (cap.params.some(p => p.key === 'duration')) {
      controls.push({ type: 'stepper', bind: { capability: cap.id, param: 'duration' }, values: DEFAULT_DURATION_STEPS })
    }
    return { id: cap.id, title: cap.name, controls }
  })
  return { groups }
}

// ---- 能力 → ToyCapabilities(桥接校验/硬限制用) ----

export function capabilitiesToToyCaps(capabilities: CapabilityDef[]): ToyCapabilities {
  return {
    perFunctionPair: true,
    functions: capabilities.map(cap => ({
      id: cap.id,
      name: cap.name,
      intensityRange: capabilityIntensityRange(cap),
      supportsMode: capabilityModeParam(cap) != null,
      modeCount: capabilityModeCount(cap)
    }))
  }
}

// ---- AI 能力清单(暴露给模型的可控范围) ----

export interface PluginCapBrief {
  id: string
  name: string
  /** 强度可控范围(清单声明的每能力强度上限) */
  intensityRange: [number, number]
  supportsMode: boolean
  modeCount: number
}

export interface PluginBrief {
  id: string
  name: string
  connected: boolean
  capabilities: PluginCapBrief[]
}

/** 插件 → AI 能力清单(连接状态由调用方标注) */
export function describePlugin(spec: PluginSpec, connected: boolean): PluginBrief {
  return {
    id: spec.descriptor.id,
    name: spec.descriptor.name,
    connected,
    capabilities: spec.capabilities.map(cap => ({
      id: cap.id,
      name: cap.name,
      intensityRange: capabilityIntensityRange(cap),
      supportsMode: capabilityModeParam(cap) != null,
      modeCount: capabilityModeCount(cap)
    }))
  }
}

// ---- 分析器(强制校验,无推导) ----

export type PluginAnalyzeResult = { ok: true, spec: PluginSpec } | { ok: false, reason: string }

function fail(reason: string): PluginAnalyzeResult {
  return { ok: false, reason }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** UUID 宽松校验:完整 128 位形式或 ≤8 位十六进制简写(Web Bluetooth 支持 16/32 位别名) */
function isValidUuid(v: string): boolean {
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) return true
  return /^[0-9a-fA-F]{1,8}$/.test(v)
}

function parseScanNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined
  const names = raw.filter((s): s is string => typeof s === 'string' && !!s.trim()).map(s => s.trim())
  return names.length ? names : undefined
}

function parseBattery(raw: unknown): ToyBatterySpec | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.supported !== 'boolean') return undefined
  return {
    supported: o.supported,
    ...(typeof o.serviceUuid === 'string' && o.serviceUuid.trim() ? { serviceUuid: o.serviceUuid.trim() } : {}),
    ...(typeof o.characteristicUuid === 'string' && o.characteristicUuid.trim() ? { characteristicUuid: o.characteristicUuid.trim() } : {})
  }
}

function parseParams(raw: unknown): { ok: true, value: ParamDef[] } | { ok: false, reason: string } {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, reason: 'capability 缺少 params 参数声明' }
  const out: ParamDef[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, reason: 'params 中存在非法参数项' }
    const p = item as Record<string, unknown>
    const key = str(p.key)
    if (!key) return { ok: false, reason: '参数缺少 key' }
    const type = str(p.type)
    if (type === 'int' || type === 'float') {
      const param: Extract<ParamDef, { type: 'int' | 'float' }> = { key, type }
      if (p.min !== undefined && !isNum(p.min)) return { ok: false, reason: `参数「${key}」的 min 必须是数字` }
      if (p.max !== undefined && !isNum(p.max)) return { ok: false, reason: `参数「${key}」的 max 必须是数字` }
      if (p.step !== undefined && !isNum(p.step)) return { ok: false, reason: `参数「${key}」的 step 必须是数字` }
      if (p.min !== undefined) param.min = p.min
      if (p.max !== undefined) param.max = p.max
      if (p.step !== undefined) param.step = p.step
      if (typeof p.unit === 'string' && p.unit.trim()) param.unit = p.unit.trim()
      if (isNum(p.default)) param.default = p.default
      if (typeof p.required === 'boolean') param.required = p.required
      if (typeof p.description === 'string' && p.description.trim()) param.description = p.description.trim()
      out.push(param)
    } else if (type === 'enum') {
      if (!Array.isArray(p.values) || !p.values.length) return { ok: false, reason: `参数「${key}」缺少 values(枚举档位)` }
      const values: { value: string | number, label: string }[] = []
      for (const v of p.values) {
        if (typeof v !== 'object' || v === null) return { ok: false, reason: `参数「${key}」的 values 项非法` }
        const vo = v as Record<string, unknown>
        const label = str(vo.label)
        if (label == null || (typeof vo.value !== 'string' && !isNum(vo.value))) {
          return { ok: false, reason: `参数「${key}」的 values 项需含 value 与 label` }
        }
        values.push({ value: vo.value as string | number, label })
      }
      const param: Extract<ParamDef, { type: 'enum' }> = { key, type: 'enum', values }
      if (typeof p.default === 'string' || isNum(p.default)) param.default = p.default
      if (typeof p.description === 'string' && p.description.trim()) param.description = p.description.trim()
      out.push(param)
    } else if (type === 'bool') {
      const param: Extract<ParamDef, { type: 'bool' }> = { key, type: 'bool' }
      if (typeof p.default === 'boolean') param.default = p.default
      if (typeof p.description === 'string' && p.description.trim()) param.description = p.description.trim()
      out.push(param)
    } else {
      return { ok: false, reason: `参数「${key}」的 type 必须是 int/float/enum/bool(实际:${type ?? '空'})` }
    }
  }
  return { ok: true, value: out }
}

function parseCapabilities(raw: unknown): { ok: true, value: CapabilityDef[] } | { ok: false, reason: string } {
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, reason: 'capabilities 必须显式声明至少一个能力(禁止隐式推导)' }
  }
  const out: CapabilityDef[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, reason: 'capabilities 中存在非法项' }
    const c = item as Record<string, unknown>
    const cid = str(c.id)
    if (!cid) return { ok: false, reason: 'capabilities 项缺少 id' }
    const cname = str(c.name)
    if (!cname) return { ok: false, reason: `capability「${cid}」缺少 name` }
    const cdesc = str(c.description)
    if (!cdesc) return { ok: false, reason: `capability「${cid}」缺少 description(AI 提示词描述)` }
    const params = parseParams(c.params)
    if (!params.ok) return { ok: false, reason: `capability「${cid}」${params.reason}` }
    // 每能力强度上限声明:必须存在 intensity 参数(int/float)且明确 max
    const intensity = params.value.find((p): p is Extract<ParamDef, { type: 'int' | 'float' }> =>
      p.key === 'intensity' && (p.type === 'int' || p.type === 'float'))
    if (!intensity) {
      return { ok: false, reason: `capability「${cid}」缺少 intensity 参数(每能力强度上限声明)` }
    }
    if (intensity.max == null) {
      return { ok: false, reason: `capability「${cid}」缺少强度上限(intensity.max)` }
    }
    if (intensity.max < 0 || intensity.max > 100) {
      return { ok: false, reason: `capability「${cid}」强度上限 ${intensity.max} 超出合法范围 0-100` }
    }
    // 0 = 停止:强度下限强制为 0(清单 min 若 >0 归一化,避免停止语义失效)
    intensity.min = 0
    out.push({ id: cid, name: cname, description: cdesc, params: params.value })
  }
  return { ok: true, value: out }
}

function parseRuntime(raw: unknown): { ok: true, value: PluginRuntime } | { ok: false, reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '缺少 runtime(执行后端声明)' }
  const o = raw as Record<string, unknown>
  const type = str(o.type)
  if (type === 'toy-protocol') {
    const protocol = validateProtocolConfig(o.protocol)
    if (!protocol) {
      return { ok: false, reason: 'runtime.toy-protocol 的 protocol 不合法(需 frame.template / frame.intensityRange / functions 每功能指令)' }
    }
    if (!protocol.gatt?.serviceUuid || !protocol.gatt?.writeUuid || !protocol.gatt?.notifyUuid) {
      return { ok: false, reason: '缺少 protocol.gatt uuid 声明(serviceUuid / writeUuid / notifyUuid)' }
    }
    for (const u of [protocol.gatt.serviceUuid, protocol.gatt.writeUuid, protocol.gatt.notifyUuid]) {
      if (!isValidUuid(u)) return { ok: false, reason: `protocol.gatt uuid 格式不合法:${u}` }
    }
    // 电量查询声明必填
    const batteryRaw = (o.protocol as Record<string, unknown> | undefined)?.battery
    const battery = parseBattery(batteryRaw)
    if (!battery) return { ok: false, reason: '缺少 protocol.battery 电量查询声明(supported 必须为布尔)' }
    if (battery.serviceUuid && !isValidUuid(battery.serviceUuid)) {
      return { ok: false, reason: `protocol.battery.serviceUuid 格式不合法:${battery.serviceUuid}` }
    }
    if (battery.characteristicUuid && !isValidUuid(battery.characteristicUuid)) {
      return { ok: false, reason: `protocol.battery.characteristicUuid 格式不合法:${battery.characteristicUuid}` }
    }
    protocol.battery = battery
    return { ok: true, value: { type: 'toy-protocol', scanNames: parseScanNames(o.scanNames), protocol } }
  }
  if (type === 'toy-code') {
    const gattRaw = o.gatt as Record<string, unknown> | undefined
    if (!gattRaw || !str(gattRaw.serviceUuid) || !str(gattRaw.writeUuid) || !str(gattRaw.notifyUuid)) {
      return { ok: false, reason: 'runtime.toy-code 缺少 gatt uuid 声明(serviceUuid / writeUuid / notifyUuid)' }
    }
    const gatt: ToyGattParams = {
      serviceUuid: str(gattRaw.serviceUuid)!,
      writeUuid: str(gattRaw.writeUuid)!,
      notifyUuid: str(gattRaw.notifyUuid)!,
      writeWithResponse: typeof gattRaw.writeWithResponse === 'boolean' ? gattRaw.writeWithResponse : true
    }
    for (const u of [gatt.serviceUuid, gatt.writeUuid, gatt.notifyUuid]) {
      if (!isValidUuid(u)) return { ok: false, reason: `runtime.toy-code gatt uuid 格式不合法:${u}` }
    }
    const battery = parseBattery(o.battery)
    if (!battery) return { ok: false, reason: 'runtime.toy-code 缺少 battery 电量查询声明(supported 必须为布尔)' }
    return { ok: true, value: { type: 'toy-code', scanNames: parseScanNames(o.scanNames), gatt, battery } }
  }
  if (type === 'none') {
    return { ok: true, value: { type: 'none' } }
  }
  return { ok: false, reason: `runtime.type 必须是 toy-protocol / toy-code / none(实际:${type ?? '空'})` }
}

function parseUi(raw: unknown, capabilities: CapabilityDef[]): { ok: true, value: UiSchema | null } | { ok: false, reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'ui 必须是对象(缺省由平台生成默认布局)' }
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.groups) || !o.groups.length) return { ok: false, reason: 'ui.groups 必须是非空数组' }
  const groups: UiGroup[] = []
  for (const g of o.groups) {
    if (typeof g !== 'object' || g === null) return { ok: false, reason: 'ui.groups 中存在非法分组' }
    const go = g as Record<string, unknown>
    const gid = str(go.id)
    if (!gid) return { ok: false, reason: 'ui 分组缺少 id' }
    const title = str(go.title) ?? gid
    if (!Array.isArray(go.controls) || !go.controls.length) return { ok: false, reason: `ui 分组「${gid}」缺少 controls` }
    const controls: ControlDef[] = []
    for (const c of go.controls) {
      if (typeof c !== 'object' || c === null) return { ok: false, reason: `ui 分组「${gid}」存在非法控件` }
      const co = c as Record<string, unknown>
      const ctype = str(co.type)
      const capExists = (capId: unknown, paramKey: unknown): boolean => {
        if (typeof capId !== 'string' || typeof paramKey !== 'string') return false
        const cap = capabilities.find(cap => cap.id === capId)
        return !!cap && cap.params.some(p => p.key === paramKey)
      }
      if (ctype === 'slider') {
        const bind = co.bind as Record<string, unknown> | undefined
        if (!bind || !capExists(bind.capability, bind.param)) return { ok: false, reason: `ui 滑块控件 bind 必须指向已声明能力的参数` }
        controls.push({ type: 'slider', bind: { capability: String(bind.capability), param: String(bind.param) } })
      } else if (ctype === 'stepper') {
        const bind = co.bind as Record<string, unknown> | undefined
        if (!bind || !capExists(bind.capability, bind.param)) return { ok: false, reason: `ui 档位控件 bind 必须指向已声明能力的参数` }
        if (!Array.isArray(co.values) || !co.values.length) return { ok: false, reason: `ui 档位控件缺少 values` }
        const values = co.values.map((v: unknown) => {
          const vo = v as Record<string, unknown>
          return { value: vo.value as string | number, label: String(vo.label ?? vo.value) }
        })
        controls.push({ type: 'stepper', bind: { capability: String(bind.capability), param: String(bind.param) }, values })
      } else if (ctype === 'select') {
        const bind = co.bind as Record<string, unknown> | undefined
        if (!bind || !capExists(bind.capability, bind.param)) return { ok: false, reason: `ui 下拉控件 bind 必须指向已声明能力的参数` }
        controls.push({ type: 'select', bind: { capability: String(bind.capability), param: String(bind.param) } })
      } else if (ctype === 'toggle') {
        const bind = co.bind as Record<string, unknown> | undefined
        if (!bind || !capExists(bind.capability, bind.param)) return { ok: false, reason: `ui 开关控件 bind 必须指向已声明能力的参数` }
        controls.push({ type: 'toggle', bind: { capability: String(bind.capability), param: String(bind.param) } })
      } else if (ctype === 'action') {
        const capId = co.capability
        if (typeof capId !== 'string' || !capabilities.some(cap => cap.id === capId)) {
          return { ok: false, reason: `ui 动作控件 capability 必须指向已声明能力` }
        }
        controls.push({
          type: 'action',
          capability: capId,
          params: (co.params && typeof co.params === 'object' ? co.params as Record<string, string | number | boolean> : {}),
          label: str(co.label) ?? '执行'
        })
      } else if (ctype === 'display') {
        const bind = co.bind as Record<string, unknown> | undefined
        if (!bind || !capExists(bind.capability, bind.param)) return { ok: false, reason: `ui 状态控件 bind 必须指向已声明能力的参数` }
        controls.push({ type: 'display', bind: { capability: String(bind.capability), param: String(bind.param) }, label: str(co.label) })
      } else {
        return { ok: false, reason: `ui 控件 type 必须是 slider/stepper/select/toggle/action/display(实际:${ctype ?? '空'})` }
      }
    }
    groups.push({ id: gid, title, controls })
  }
  return { ok: true, value: { groups } }
}

/**
 * 分析清单(强制校验,无推导):顶层/capabilities/runtime/ui 逐字段检查,
 * 缺失必填字段即拒绝并给出具体缺项;通过后归一化输出 PluginSpec。
 */
export function analyzePluginDescriptor(raw: unknown): PluginAnalyzeResult {
  if (typeof raw !== 'object' || raw === null) return fail('清单必须是 JSON 对象')
  const o = raw as Record<string, unknown>

  const id = str(o.id)
  if (!id) return fail('缺少 id(稳定标识)')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return fail('id 只能包含小写字母/数字/连字符')
  const name = str(o.name)
  if (!name) return fail('缺少 name(展示名)')
  const version = str(o.version)
  if (!version) return fail('缺少 version(版本号)')
  const icon = str(o.icon)
  const description = str(o.description)

  const caps = parseCapabilities(o.capabilities)
  if (!caps.ok) return fail(caps.reason)

  const rt = parseRuntime(o.runtime)
  if (!rt.ok) return fail(rt.reason)
  const runtime = rt.value

  // 一致性:玩具协议下 capability 强度上限/模式档位不得超过帧声明范围
  if (runtime.type === 'toy-protocol') {
    const [, fHi] = runtime.protocol.frame.intensityRange
    const [, mHi] = runtime.protocol.frame.modeRange ?? [1, 1]
    for (const cap of caps.value) {
      const [iLo, iMax] = capabilityIntensityRange(cap)
      if (iMax > fHi) return fail(`capability「${cap.id}」强度上限 ${iMax} 超出帧范围上限 ${fHi}(protocol.frame.intensityRange)`)
      if (iLo < 0) return fail(`capability「${cap.id}」强度下限必须为 0`)
      const modeCount = capabilityModeCount(cap)
      if (modeCount > mHi) return fail(`capability「${cap.id}」模式档位数 ${modeCount} 超出帧 modeRange 上限 ${mHi}`)
    }
  }

  const uiRes = parseUi(o.ui, caps.value)
  if (!uiRes.ok) return fail(uiRes.reason)
  const uiSchema = uiRes.value ?? defaultUiSchema(caps.value)

  const descriptor: PluginDescriptor = {
    id, name, version,
    ...(icon ? { icon } : {}),
    ...(description ? { description } : {}),
    runtime,
    capabilities: caps.value,
    ...(uiRes.value ? { ui: uiRes.value } : {})
  }
  return { ok: true, spec: { descriptor, capabilities: caps.value, uiSchema, runtime } }
}
