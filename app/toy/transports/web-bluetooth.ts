// app/toy/transports/web-bluetooth.ts
// Web Bluetooth 传输:浏览器直连(桌面/Android Chrome;iOS Safari 无 Web Bluetooth,暂不支持)。
// 注意:requestDevice 必须在用户手势内调用,scan() 弹出系统选择器并记住所选设备;
// listKnownDevices() 走 getDevices() 返回本站点已授权过的设备(免系统选择器),点击列表项即可直连;
// 通知走 startNotifications()(勿手动写 CCCD 0x2902)。
import type { ToyBatterySpec, ToyGattParams, ToyTransport, ToyTransportDevice } from './transport'

/** Web Bluetooth 的最小类型面(避免依赖 @types/web-bluetooth) */
interface RawBleDevice {
  id: string
  name?: string
  gatt?: {
    connect(): Promise<RawGattServer>
    disconnected: boolean
    disconnect(): void
  }
  addEventListener(ev: 'gattserverdisconnected', cb: () => void): void
}
interface RawGattServer {
  disconnect(): void
  getPrimaryService(uuid: string): Promise<{
    getCharacteristic(uuid: string): Promise<RawGattCharacteristic>
  }>
}
interface RawGattCharacteristic {
  readValue(): Promise<DataView>
  writeValueWithResponse(bytes: Uint8Array): Promise<void>
  writeValueWithoutResponse?(bytes: Uint8Array): Promise<void>
  startNotifications(): Promise<void>
}

interface RawBluetooth {
  requestDevice(options: {
    filters?: { name?: string, namePrefix?: string }[]
    optionalServices?: string[]
  }): Promise<RawBleDevice>
  /** 返回本站点已授权过的设备(免系统选择器;Chrome 85+;不支持时 undefined) */
  getDevices?(): Promise<RawBleDevice[]>
}

function getBluetooth(): RawBluetooth | null {
  if (typeof navigator === 'undefined') return null
  const nav = navigator as Navigator & { bluetooth?: RawBluetooth }
  return nav.bluetooth ?? null
}

let pickedDevice: RawBleDevice | null = null
/** 已授权设备缓存(getDevices 结果,id → 设备;直连用,免系统选择器) */
const knownDevices = new Map<string, RawBleDevice>()
let currentChar: RawGattCharacteristic | null = null
const disconnectHandlers = new Set<() => void>()

// 电量:设备连接成功后读取一次缓存下来(自定义设备列表展示);UUID 默认标准电池服务,
// 自定义设备由清单 protocol.battery 声明自己的服务/特征
const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb'
const BATTERY_LEVEL_UUID = '00002a19-0000-1000-8000-00805f9b34fb'
const batteryCache = new Map<string, number>()

/** 电量服务的实际 UUID(清单声明优先,缺省标准电池服务) */
function batteryServiceUuid(battery?: ToyBatterySpec): string {
  return battery?.serviceUuid ?? BATTERY_SERVICE_UUID
}

/** 电量特征的实际 UUID(清单声明优先,缺省标准电池特征) */
function batteryLevelUuid(battery?: ToyBatterySpec): string {
  return battery?.characteristicUuid ?? BATTERY_LEVEL_UUID
}

// 已连接设备的本地持久化兜底:Chrome 的 getDevices 偶发不返回已授权设备(权限存储未刷新/
// origin/端口变化/平台差异),列表合并本地记录展示;直连仍需 getDevices 给出设备句柄,
// 拿不到时引导重新授权一次(系统选择器)。
const KNOWN_CACHE_KEY = 'toy.knownDevices.v1'
interface KnownDeviceRecord { id: string, name: string, battery: number | null, connectedAt: number }

function loadKnownCache(): KnownDeviceRecord[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(KNOWN_CACHE_KEY)
    return raw ? (JSON.parse(raw) as KnownDeviceRecord[]) : []
  } catch {
    return []
  }
}

function saveKnownCache(records: KnownDeviceRecord[]): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(KNOWN_CACHE_KEY, JSON.stringify(records)) } catch { /* 隐私模式等场景忽略 */ }
}

/** 记录一次成功扫描/连接的设备(去重置顶,最多留 20 条;battery 为 null 时沿用旧值) */
function rememberDevice(id: string, name: string, battery: number | null): void {
  const records = loadKnownCache()
  const prev = records.find(r => r.id === id)
  const rest = records.filter(r => r.id !== id)
  rest.unshift({ id, name, battery: battery ?? prev?.battery ?? null, connectedAt: Date.now() })
  saveKnownCache(rest.slice(0, 20))
}

/** 读取电量写入缓存并持久化;设备无电池服务或授权未含电池服务(旧授权)时静默跳过,不影响连接 */
async function readBattery(raw: RawBleDevice, server: RawGattServer, battery?: ToyBatterySpec): Promise<void> {
  if (battery && battery.supported === false) return
  try {
    const batteryService = await server.getPrimaryService(batteryServiceUuid(battery))
    const batteryChar = await batteryService.getCharacteristic(batteryLevelUuid(battery))
    const value = await batteryChar.readValue()
    batteryCache.set(raw.id, value.getUint8(0))
  } catch {
    batteryCache.delete(raw.id)
  }
}

/** getDevices 结果 + 本地历史合并(浏览器未返回已授权设备时,本地记录兜底展示) */
async function listAuthorizedDevices(): Promise<ToyTransportDevice[]> {
  const bt = getBluetooth()
  if (!bt || typeof bt.getDevices !== 'function') return []
  const devices = await bt.getDevices()
  knownDevices.clear()
  for (const d of devices) knownDevices.set(d.id, d)
  const merged = new Map<string, ToyTransportDevice>()
  for (const d of devices) merged.set(d.id, { id: d.id, name: d.name ?? '未知设备' })
  for (const r of loadKnownCache()) if (!merged.has(r.id)) merged.set(r.id, { id: r.id, name: r.name })
  return [...merged.values()]
}

async function attach(raw: RawBleDevice, gatt: ToyGattParams, battery?: ToyBatterySpec): Promise<void> {
  if (!raw.gatt) throw new Error('设备不可连接(无 GATT)')
  const server = await raw.gatt.connect()
  let service
  try {
    service = await server.getPrimaryService(gatt.serviceUuid)
  } catch (e) {
    // 旧授权(授权时未含服务)的已授权设备直连会抛 SecurityError:提示重新走一次系统选择器
    if (e instanceof Error && /not allowed to access any service/.test(e.message)) {
      throw new Error('蓝牙服务未授权:请点击「连接设备」重新配对授权')
    }
    throw e
  }
  const writeChar = await service.getCharacteristic(gatt.writeUuid)
  const notifyChar = await service.getCharacteristic(gatt.notifyUuid)
  // 通知必须走 startNotifications,新版 Chrome 会拦截手动写 CCCD(0x2902)
  await notifyChar.startNotifications()
  currentChar = writeChar
  await readBattery(raw, server, battery)
  rememberDevice(raw.id, raw.name ?? '未知设备', batteryCache.get(raw.id) ?? null)

  raw.addEventListener('gattserverdisconnected', () => {
    currentChar = null
    for (const cb of disconnectHandlers) cb()
  })
}

export const webBluetoothTransport: ToyTransport = {
  id: 'web-bluetooth',
  name: '蓝牙直连 (Web Bluetooth)',

  async scan(scanNames?: string[], gatt?: ToyGattParams, battery?: ToyBatterySpec): Promise<ToyTransportDevice[]> {
    const bt = getBluetooth()
    if (!bt) throw new Error('当前浏览器不支持 Web Bluetooth(请用桌面/Android Chrome)')
    // 按广播名前缀过滤(啵啵贝广播名 SOSEXY);无扫描名时列出全部设备由用户选择
    const filters = scanNames?.length
      ? scanNames.map(name => ({ namePrefix: name }))
      : undefined
    // 服务 UUID 必须放进 optionalServices,否则连接时 getPrimaryService 会被 Chrome 拒绝;
    // 清单声明的电量服务一并授权(支持时),连接后可读电量
    const optionalServices = [...(gatt?.serviceUuid ? [gatt.serviceUuid] : [])]
    if (battery && battery.supported !== false) optionalServices.push(batteryServiceUuid(battery))
    pickedDevice = await bt.requestDevice({
      filters,
      optionalServices
    })
    // 记住授权结果,下次打开免选择器直连
    knownDevices.set(pickedDevice.id, pickedDevice)
    rememberDevice(pickedDevice.id, pickedDevice.name ?? '未知设备', null)
    return [{ id: 'picked', name: pickedDevice.name ?? '未知设备' }]
  },

  async listKnownDevices(): Promise<ToyTransportDevice[]> {
    return listAuthorizedDevices()
  },

  async connect(device: ToyTransportDevice, gatt: ToyGattParams, battery?: ToyBatterySpec): Promise<void> {
    // 扫描来源(id='picked')用 requestDevice 结果;直连来源用 getDevices 缓存
    const raw = device.id === 'picked' ? pickedDevice : knownDevices.get(device.id)
    if (!raw) throw new Error('设备授权记录丢失,请重新授权(系统蓝牙弹窗确认一次)')
    await attach(raw, gatt, battery)
  },

  async write(bytes: Uint8Array): Promise<void> {
    if (!currentChar) throw new Error('设备未连接')
    if (currentChar.writeValueWithResponse) {
      await currentChar.writeValueWithResponse(bytes)
    } else {
      await currentChar.writeValueWithoutResponse?.(bytes)
    }
  },

  onDisconnect(cb: () => void): () => void {
    disconnectHandlers.add(cb)
    return () => {
      disconnectHandlers.delete(cb)
    }
  },

  async disconnect(): Promise<void> {
    pickedDevice?.gatt?.disconnect()
    currentChar = null
  },

  getBattery(id: string): number | null {
    const mem = batteryCache.get(id)
    if (mem != null) return mem
    return loadKnownCache().find(r => r.id === id)?.battery ?? null
  }
}
