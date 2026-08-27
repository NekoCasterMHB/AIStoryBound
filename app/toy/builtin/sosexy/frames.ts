// app/toy/builtin/sosexy/frames.ts
// 帧构造(品牌边界):基于 protocol.json 生成控制/初始化/停止帧。
// 引擎本体在 shared/toy.ts(通用 Tier 1 帧引擎),这里只做品牌侧转发,方便演示脚本与测试直接引用。
import protocol from './protocol.json'

export {
  buildProtocolControlFrame,
  buildProtocolInitFrame,
  buildProtocolStopFrames,
  framesToHex
} from '../../../../shared/toy'
export type { ToyProtocolConfig } from '../../../../shared/toy'
export const sosexyProtocol = protocol
