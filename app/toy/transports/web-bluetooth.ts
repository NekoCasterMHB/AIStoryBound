// app/toy/transports/web-bluetooth.ts
// Web Bluetooth 传输:浏览器直连(桌面/Android Chrome;iOS Safari 无 Web Bluetooth,暂不支持)。
// 注意:requestDevice 必须在用户手势内调用,scan() 弹出系统选择器并记住所选设备;
// listKnownDevices() 走 getDevices() 返回本站点已授权过的设备(免系统选择器),点击列表项即可直连;
// 通知走 startNotifications()(勿手动写 CCCD 0x2902)。
import type { ToyGattParams, ToyTransport, ToyTransportDevice } from './transport'

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

async function attach(raw: RawBleDevice, gatt: ToyGattParams): Promise<void> {
  if (!raw.gatt) throw new Error('设备不可连接(无 GATT)')
  const server = await raw.gatt.connect()
  const service = await server.getPrimaryService(gatt.serviceUuid)
  const writeChar = await service.getCharacteristic(gatt.writeUuid)
  const notifyChar = await service.getCharacteristic(gatt.notifyUuid)
  // 通知必须走 startNotifications,新版 Chrome 会拦截手动写 CCCD(0x2902)
  await notifyChar.startNotifications()
  currentChar = writeChar

  raw.addEventListener('gattserverdisconnected', () => {
    currentChar = null
    for (const cb of disconnectHandlers) cb()
  })
}

export const webBluetoothTransport: ToyTransport = {
  id: 'web-bluetooth',
  name: '蓝牙直连 (Web Bluetooth)',

  async scan(scanNames?: string[]): Promise<ToyTransportDevice[]> {
    const bt = getBluetooth()
    if (!bt) throw new Error('当前浏览器不支持 Web Bluetooth(请用桌面/Android Chrome)')
    // 按广播名前缀过滤(啵啵贝广播名 SOSEXY);无扫描名时列出全部设备由用户选择
    const filters = scanNames?.length
      ? scanNames.map(name => ({ namePrefix: name }))
      : undefined
    pickedDevice = await bt.requestDevice({ filters, optionalServices: [] })
    // 记住授权结果,下次打开免选择器直连
    knownDevices.set(pickedDevice.id, pickedDevice)
    return [{ id: 'picked', name: pickedDevice.name ?? '未知设备' }]
  },

  async listKnownDevices(): Promise<ToyTransportDevice[]> {
    const bt = getBluetooth()
    if (!bt || typeof bt.getDevices !== 'function') return []
    const devices = await bt.getDevices()
    knownDevices.clear()
    for (const d of devices) knownDevices.set(d.id, d)
    return devices
      .filter(d => d.name)
      .map(d => ({ id: d.id, name: d.name! }))
  },

  async connect(device: ToyTransportDevice, gatt: ToyGattParams): Promise<void> {
    // 扫描来源(id='picked')用 requestDevice 结果;直连来源用 getDevices 缓存
    const raw = device.id === 'picked' ? pickedDevice : knownDevices.get(device.id)
    if (!raw) throw new Error('未找到设备,请先扫描或刷新已授权列表')
    await attach(raw, gatt)
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
  }
}
