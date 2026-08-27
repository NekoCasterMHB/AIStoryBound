// app/toy/runtime/adapter-loader.ts
// 适配器注册与加载:
// - 内置适配器(啵啵贝)静态注册;
// - 玩家适配器通过文件选择器导入(manifest.json + 可选 adapter.js),校验后存 IndexedDB;
//   Tier 1(声明式 protocol)→ createProtocolAdapter 零代码;Tier 2(adapter.js)→ Worker 沙箱执行。
import { createProtocolAdapter, validateAdapterManifest } from '#shared/toy'
import type { ToyAdapter, ToyAdapterManifest } from '#shared/toy'
import { SOSEXY_ADAPTER } from '../builtin/sosexy/adapter'
import { deleteImportedAdapter, listImportedAdapters, saveImportedAdapter } from '../store'
import type { ImportedToyAdapterRecord } from '../store'
import { createSandboxedAdapter } from './worker'

/** 内置适配器注册表(未来新增品牌在此追加) */
export function getBuiltinAdapters(): ToyAdapter[] {
  return [SOSEXY_ADAPTER]
}

/** 已导入的适配器(IndexedDB)→ 可执行 ToyAdapter(Tier 1 配置生成 / Tier 2 Worker 沙箱) */
export function buildImportedAdapter(record: ImportedToyAdapterRecord): ToyAdapter | null {
  const m = record.manifest
  if (m.protocol) {
    return createProtocolAdapter(m.protocol, {
      id: m.id,
      name: m.name,
      version: m.version,
      scanNames: m.scanNames,
      functionNames: m.functionNames
    })
  }
  if (record.code) {
    try {
      return createSandboxedAdapter(m, record.code)
    } catch (e) {
      console.warn('[toy] 沙箱适配器加载失败', m.id, e)
      return null
    }
  }
  return null
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

/** 删除已导入适配器 */
export async function removeImportedAdapter(id: string): Promise<void> {
  await deleteImportedAdapter(id)
}

/**
 * 从文件选择器结果导入适配器:识别 manifest.json(必填)+ adapter.js(可选)。
 * 校验 manifest 合法后落库并返回可执行适配器;不合法抛出带中文说明的 Error。
 */
export async function importAdapterFiles(files: File[]): Promise<ToyAdapter> {
  const manifestFile = files.find(f => f.name === 'manifest.json')
  if (!manifestFile) throw new Error('缺少 manifest.json(适配器声明文件)')
  const codeFile = files.find(f => f.name === 'adapter.js')

  let parsed: unknown
  try {
    parsed = JSON.parse(await manifestFile.text())
  } catch {
    throw new Error('manifest.json 不是合法 JSON,请检查格式')
  }
  const v = validateAdapterManifest(parsed)
  if (!v.ok) throw new Error(`适配器校验失败:${v.reason}`)
  const manifest: ToyAdapterManifest = v.manifest

  // Tier 1:protocol 配置驱动,零代码;Tier 2:必须提供 adapter.js 纯函数
  if (!manifest.protocol && !codeFile) {
    throw new Error('该适配器没有 protocol 配置,需要 adapter.js 代码文件(Tier 2 适配器)')
  }
  const code = codeFile ? await codeFile.text() : undefined
  if (code && !code.includes('buildFrames')) {
    throw new Error('adapter.js 需要定义 self.buildFrames 函数(见适配器 SDK 模板)')
  }

  const record: ImportedToyAdapterRecord = {
    id: manifest.id,
    manifest,
    code,
    importedAt: new Date().toISOString()
  }
  await saveImportedAdapter(record)
  const adapter = buildImportedAdapter(record)
  if (!adapter) throw new Error('适配器加载失败,请检查 manifest 配置')
  return adapter
}
