// app/toy/transports/transport.ts
// 传输层抽象:适配器产出字节帧,传输层负责把字节送到设备。
// - web-bluetooth:浏览器直连(桌面/Android Chrome);iOS 无 Web Bluetooth,暂不支持
// - mock:模拟设备(无硬件开发/演示/验收)
// 未来加网关/中继时新增实现即可,适配器与 ToyApi 无需改动。
import type { ToyProtocolConfig } from '#shared/toy'

export interface ToyTransportDevice {
  id: string
  name: string
}

/** 连接所需的 GATT 参数(来自适配器 manifest.protocol.gatt) */
export type ToyGattParams = NonNullable<ToyProtocolConfig['gatt']>

export interface ToyTransport {
  id: 'web-bluetooth' | 'mock'
  /** 界面展示名 */
  name: string
  /** 发现设备(Web Bluetooth 会弹出系统选择器) */
  scan(scanNames?: string[]): Promise<ToyTransportDevice[]>
  /** 已授权设备列表(免系统选择器;Web Bluetooth 用 getDevices,仅含此前用户授权过的设备;不支持则返回空) */
  listKnownDevices?(): Promise<ToyTransportDevice[]>
  /** 连接 + 开启通知(CCCD 走 startNotifications,勿手动写 0x2902);设备来自 scan 或 listKnownDevices */
  connect(device: ToyTransportDevice, gatt: ToyGattParams): Promise<void>
  /** 写入一帧 */
  write(bytes: Uint8Array): Promise<void>
  /** 断连回调(注册返回注销函数) */
  onDisconnect(cb: () => void): () => void
  /** 主动断开 */
  disconnect(): Promise<void>
}
