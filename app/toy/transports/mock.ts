// app/toy/transports/mock.ts
// 模拟设备传输:不依赖蓝牙,记录写入的帧并模拟断连——无硬件开发/演示/验收用。
// 演示脚本(scripts/demo/mvp3-device.mts)也直接复用本实现跑端到端链路。
// 多连接:每个连接调用 createMockTransport() 获得独立实例与独立状态(writeLog 互不干扰);
// 全局单例 mockTransport 复用导出的 mockTransportState(兼容旧调用方/演示脚本读取日志)。
import type { ToyBatterySpec, ToyGattParams, ToyTransport, ToyTransportDevice } from './transport'

export interface MockTransportState {
  connected: boolean
  deviceName: string | null
  /** 写入历史(每帧的十六进制串) */
  writeLog: string[]
}

/** 全局单例的模拟状态(旧调用方/演示脚本读取;新多连接实例各自持有独立 state) */
export const mockTransportState: MockTransportState = {
  connected: false,
  deviceName: null,
  writeLog: []
}

export interface MockTransportInstance extends ToyTransport {
  /** 本实例独立状态(多连接下各自记录) */
  state: MockTransportState
}

/** 创建模拟设备传输实例(state 缺省 = 新建独立状态;传全局 mockTransportState 即成为全局单例) */
export function createMockTransport(state: MockTransportState = { connected: false, deviceName: null, writeLog: [] }): MockTransportInstance {
  let disconnectCb: (() => void) | undefined

  const transport: MockTransportInstance = {
    id: 'mock',
    name: '模拟设备 (Mock)',
    state,

    async scan(): Promise<ToyTransportDevice[]> {
      return [{ id: 'mock-sosexy', name: '模拟啵啵贝 (Mock)' }]
    },

    async connect(device: ToyTransportDevice, _gatt: ToyGattParams, _battery?: ToyBatterySpec): Promise<void> {
      state.connected = true
      state.deviceName = device.name
      state.writeLog = []
    },

    async write(bytes: Uint8Array): Promise<void> {
      state.writeLog.push(
        Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
      )
    },

    onDisconnect(cb: () => void): () => void {
      disconnectCb = cb
      return () => {
        if (disconnectCb === cb) disconnectCb = undefined
      }
    },

    async disconnect(): Promise<void> {
      if (!state.connected) return
      state.connected = false
      const cb = disconnectCb
      disconnectCb = undefined
      cb?.()
    }
  }
  return transport
}

/** 全局单例(兼容旧调用方/演示脚本;多连接请用 createMockTransport 各建实例) */
export const mockTransport: MockTransportInstance = createMockTransport(mockTransportState)

/** 供脚本/测试手动触发"设备掉线"(验证断连自动停止);对全局单例生效 */
export function mockForceDisconnect(): void {
  void mockTransport.disconnect()
}
