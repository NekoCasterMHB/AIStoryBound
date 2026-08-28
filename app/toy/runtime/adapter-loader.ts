// app/toy/runtime/adapter-loader.ts
// 插件注册与加载(只认新版 PluginDescriptor,放弃旧版兼容):
// - 内置插件(啵啵贝)静态注册;
// - 玩家插件通过文件选择器导入(manifest.json + 可选 adapter.js,支持 zip),
//   强制校验后存 IndexedDB;
//   Tier 1(声明式 protocol)→ createProtocolAdapter 零代码;Tier 2(adapter.js)→ Worker 沙箱。
import { unzipSync } from 'fflate'
import { analyzePluginDescriptor, capabilitiesToToyCaps, describePlugin } from '#shared/plugin'
import type { PluginDescriptor, PluginSpec } from '#shared/plugin'
import { createProtocolAdapter } from '#shared/toy'
import type { ToyAdapter, ToyAdapterManifest } from '#shared/toy'
import { SOSEXY_PLUGIN } from '../builtin/sosexy/plugin'
import { deleteImportedAdapter, listImportedAdapters, saveImportedAdapter } from '../store'
import type { ImportedPluginRecord } from '../store'
import { createSandboxedAdapter } from './worker'

/** 内置插件注册表(未来新增品牌在此追加) */
export function getBuiltinPlugins(): PluginDescriptor[] {
  return [SOSEXY_PLUGIN]
}

/** 内置适配器(由内置 PluginDescriptor 分析 + 桥接) */
export function getBuiltinAdapters(): ToyAdapter[] {
  const out: ToyAdapter[] = []
  for (const d of getBuiltinPlugins()) {
    const v = analyzePluginDescriptor(d)
    if (v.ok) {
      const a = buildAdapterFromSpec(v.spec)
      if (a) out.push(a)
    }
  }
  return out
}

/**
 * PluginSpec → 可执行 ToyAdapter:
 * - toy-protocol:Tier 1 帧引擎零代码生成,capabilities 用清单显式声明的范围覆盖;
 * - toy-code:Worker 沙箱执行 adapter.js 纯函数;
 * - none:无执行后端(仅 UI/AI 暴露),返回 null。
 */
export function buildAdapterFromSpec(spec: PluginSpec, code?: string): ToyAdapter | null {
  const { descriptor, runtime } = spec
  const scanNames = 'scanNames' in runtime ? runtime.scanNames : undefined
  const baseManifest: Omit<ToyAdapterManifest, 'capabilities'> = {
    id: descriptor.id,
    name: descriptor.name,
    version: descriptor.version,
    scanNames
  }
  const caps = capabilitiesToToyCaps(spec.capabilities)

  if (runtime.type === 'toy-protocol') {
    const adapter = createProtocolAdapter(runtime.protocol, baseManifest)
    return {
      ...adapter,
      manifest: {
        ...adapter.manifest,
        protocol: runtime.protocol,
        capabilities: caps
      }
    }
  }
  if (runtime.type === 'toy-code') {
    if (!code) return null
    const manifest: ToyAdapterManifest = {
      ...baseManifest,
      gatt: runtime.gatt,
      battery: runtime.battery,
      capabilities: caps
    }
    try {
      return createSandboxedAdapter(manifest, code)
    } catch (e) {
      console.warn('[toy] 沙箱适配器加载失败', descriptor.id, e)
      return null
    }
  }
  return null
}

/** 已导入的插件(IndexedDB)→ 可执行 ToyAdapter */
export function buildImportedAdapter(record: ImportedPluginRecord): ToyAdapter | null {
  const v = analyzePluginDescriptor(record.descriptor)
  if (!v.ok) {
    console.warn('[toy] 导入插件分析失败', record.id, v.reason)
    return null
  }
  return buildAdapterFromSpec(v.spec, record.code)
}

/** 全部可用适配器(内置 + 已导入) */
export async function loadAllAdapters(): Promise<ToyAdapter[]> {
  const imported = await listImportedAdapters()
  const adapters: ToyAdapter[] = [...getBuiltinAdapters()]
  for (const rec of imported) {
    const a = buildImportedAdapter(rec)
    if (a) adapters.push(a)
  }
  return adapters
}

/** 全部已加载插件的 PluginSpec(游戏页能力注入用) */
export async function loadAllPluginSpecs(): Promise<PluginSpec[]> {
  const imported = await listImportedAdapters()
  const specs: PluginSpec[] = []
  for (const d of getBuiltinPlugins()) {
    const v = analyzePluginDescriptor(d)
    if (v.ok) specs.push(v.spec)
  }
  for (const rec of imported) {
    const v = analyzePluginDescriptor(rec.descriptor)
    if (v.ok) specs.push(v.spec)
  }
  return specs
}

/** 删除已导入插件 */
export async function removeImportedAdapter(id: string): Promise<void> {
  await deleteImportedAdapter(id)
}

/**
 * 从文件选择器结果导入插件:识别 manifest.json(必填)+ adapter.js(可选);支持 zip 包。
 * 按平台强制格式校验(缺失必填字段即拒绝并给出缺项),通过后落库并返回可执行适配器。
 */
export async function importAdapterFiles(files: File[]): Promise<ToyAdapter> {
  if (!files.length) throw new Error('未选择任何文件')
  const first = files[0]
  if (!first) throw new Error('未选择任何文件')
  let manifestText: string | undefined
  let codeText: string | undefined

  const singleZip = files.length === 1 && /\.zip$/i.test(first.name)
  if (singleZip) {
    const buf = new Uint8Array(await first.arrayBuffer())
    let entries: ReturnType<typeof unzipSync>
    try {
      entries = unzipSync(buf)
    } catch {
      throw new Error('zip 解压失败:请确认是标准 zip 且未加密')
    }
    const names = Object.keys(entries)
    const manifestEntry = names.find(n => n.endsWith('manifest.json'))
    const codeEntry = names.find(n => n.endsWith('adapter.js'))
    if (!manifestEntry) throw new Error('zip 内缺少 manifest.json(插件声明文件)')
    const manifestBytes = entries[manifestEntry]
    if (!manifestBytes) throw new Error('zip 内 manifest.json 内容为空')
    manifestText = new TextDecoder().decode(manifestBytes)
    if (codeEntry && entries[codeEntry]) codeText = new TextDecoder().decode(entries[codeEntry])
  } else {
    const manifestFile = files.find(f => f.name === 'manifest.json')
    if (!manifestFile) throw new Error('缺少 manifest.json(插件声明文件)')
    const codeFile = files.find(f => f.name === 'adapter.js')
    manifestText = await manifestFile.text()
    codeText = codeFile ? await codeFile.text() : undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    throw new Error('manifest.json 不是合法 JSON,请检查格式')
  }
  const v = analyzePluginDescriptor(parsed)
  if (!v.ok) throw new Error(`插件校验失败:${v.reason}`)
  const spec = v.spec

  // Tier 2 代码适配器必须提供 adapter.js 纯函数
  if (spec.runtime.type === 'toy-code' && !codeText) {
    throw new Error('runtime 为 toy-code 时,必须提供 adapter.js 代码文件(见配置制作指南)')
  }
  if (codeText && !codeText.includes('buildFrames')) {
    throw new Error('adapter.js 需要定义 self.buildFrames 函数(见配置制作指南)')
  }

  const record: ImportedPluginRecord = {
    id: spec.descriptor.id,
    descriptor: spec.descriptor,
    code: codeText,
    importedAt: new Date().toISOString()
  }
  await saveImportedAdapter(record)
  const adapter = buildAdapterFromSpec(spec, codeText)
  if (!adapter) throw new Error('插件加载失败,请检查配置(执行后端不支持)')
  return adapter
}

/** 供 UI 展示的插件能力清单(带连接状态) */
export function briefFromSpec(spec: PluginSpec, connected: boolean) {
  return describePlugin(spec, connected)
}
