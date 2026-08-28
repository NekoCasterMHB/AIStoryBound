// app/toy/transports/mock.ts
// 模拟设备传输:不依赖蓝牙,记录写入的帧并模拟断连——无硬件开发/演示/验收用。
// 演示脚本(scripts/demo/mvp3-device.mts)也直接复用本实现跑端到端链路。
import type { ToyBatterySpec, ToyGattParams, ToyTransport, ToyTransportDevice } from './transport'

export interface MockTransportState {
  connected: boolean
  deviceName: string | null
  /** 写入历史(每帧的十六进制串) */
  writeLog: string[]
}

/** 全局可见的模拟状态(面板/演示可读取校验) */
export const mockTransportState: MockTransportState = {
  connected: false,
  deviceName: null,
  writeLog: []
}

let disconnectCb: (() => void) | undefined

/** 模拟设备传输(纯 JS,无 DOM/蓝牙依赖,Node 与浏览器均可运行) */
export const mockTransport: ToyTransport = {
  id: 'mock',
  name: '模拟设备 (Mock)',

  async scan(): Promise<ToyTransportDevice[]> {
    return [{ id: 'mock-sosexy', name: '模拟啵啵贝 (Mock)' }]
  },

  async connect(device: ToyTransportDevice, _gatt: ToyGattParams, _battery?: ToyBatterySpec): Promise<void> {
    mockTransportState.connected = true
    mockTransportState.deviceName = device.name
    mockTransportState.writeLog = []
  },

  async write(bytes: Uint8Array): Promise<void> {
    mockTransportState.writeLog.push(
      Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
    )
  },

  onDisconnect(cb: () => void): () => void {
    // 模拟设备不主动断连;disconnect() 会触发回调
    disconnectCb = cb
    return () => {
      disconnectCb = undefined
    }
  },

  async disconnect(): Promise<void> {
    if (!mockTransportState.connected) return
    mockTransportState.connected = false
    const cb = disconnectCb
    disconnectCb = undefined
    cb?.()
  }
}

/** 供脚本/测试手动触发"设备掉线"(验证断连自动停止) */
export function mockForceDisconnect(): void {
  void mockTransport.disconnect()
}
