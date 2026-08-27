// app/toy/builtin/sosexy/adapter.ts
// 啵啵贝(FUNF SOSEXY)内置适配器:Tier 1 声明式适配器,零代码——
// 协议细节全部在 protocol.json(UUID/帧模板/通道/初始化),由 createProtocolAdapter 生成。
// 品牌知识只存在于本目录:上层(ToyApi/AI)只见统一语义命令。
import { createProtocolAdapter, framesToHex } from '../../../../shared/toy'
import type { ToyAdapter, ToyProtocolConfig } from '../../../../shared/toy'
import protocol from './protocol.json'

// JSON 推断的 number[] 收窄为元组 [number, number](运行时结构一致)
const sosexyProtocol = protocol as unknown as ToyProtocolConfig

export const SOSEXY_ADAPTER: ToyAdapter = createProtocolAdapter(sosexyProtocol, {
  id: 'sosexy',
  name: '啵啵贝 (FUNF SOSEXY)',
  version: '1.0.0',
  scanNames: ['SOSEXY'],
  functionNames: {
    suction: '吮吸',
    vibration: '震动',
    electric: '微电流'
  }
})

/** 调试/演示:打印一帧 */
export function logSosexyFrame(frames: Uint8Array[]): string[] {
  return framesToHex(frames)
}
