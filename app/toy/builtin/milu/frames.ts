// app/toy/builtin/milu/frames.ts
// 迷路(Kisstoy Lost)帧构造(品牌边界):galaku 协议编解码 + 内置代码适配器工厂。
// 协议来源:buttplug.io galaku 实现(crates/buttplug_server/src/device/protocol_impl/galaku.rs)
// + 设备配置(QCVW 震动版 / QCSW 吮吸版 / QCPW 入体版,双马达 0-100),
// 帧算法已对 buttplug 官方测试向量逐字节验证(见 frames.test.ts)。
// 帧为链式加密(每字节依赖前一输出字节),声明式帧模板(Tier 1)表达不了,
// 因此走内置代码适配器:纯函数 + 闭包状态,不经 Worker 沙箱(见 adapter-loader 注册)。
import type { NormalizedCommand, ToyAdapter, ToyAdapterManifest } from '#shared/toy'

/**
 * galaku 帧混淆表(官方固件内置;行 = 前一输出字节低 2 位,列 = 字节序号)。
 * 12 列与帧定长 12 字节一致。
 */
const KEY_TAB: readonly (readonly number[])[] = [
  [0, 24, 152, 247, 165, 61, 13, 41, 37, 80, 68, 70],
  [0, 69, 110, 106, 111, 120, 32, 83, 45, 49, 46, 55],
  [0, 101, 120, 32, 84, 111, 121, 115, 10, 142, 157, 163],
  [0, 197, 214, 231, 248, 10, 50, 32, 111, 98, 13, 10]
]

/**
 * galaku 帧加密:明文(10 字节)= 0x5A + 保留 + 命令 + 参数;
 * 外层加 0x23 前缀与「字节和」校验和(u32,加密后才截断到 u8),
 * 再按 KEY_TAB 链式混淆:out[i] = ((tab[out[i-1] & 3][i] ^ 0x23 ^ plain[i]) + tab) & 0xFF。
 */
export function galakuEncrypt(plain: number[]): Uint8Array {
  const data = [0x23, ...plain]
  data.push(data.reduce((sum, b) => sum + b, 0))
  const out = new Uint8Array(data.length)
  out[0] = 0x23
  for (let i = 1; i < data.length; i++) {
    // 表 12 列与帧定长 12 字节一致,取值恒在界内
    const a = KEY_TAB[out[i - 1]! & 3]![i]!
    out[i] = ((a ^ 0x23 ^ data[i]!) + a) & 0xFF
  }
  return out
}

/** 双通道控制帧:命令 0x40/子命令 0x03,通道 0/1 强度各占 1 字节(0-100,一帧同时携带两通道) */
export function galakuDualChannelFrame(ch0: number, ch1: number): Uint8Array {
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
  return galakuEncrypt([0x5A, 0, 0, 1, 0x40, 0x03, clamp(ch0), clamp(ch1), 0, 0])
}

/** 电量查询帧(命令 0x13;设备从通知特征回 1 字节百分比。平台电量读法不兼容,暂未使用) */
export function galakuBatteryQueryFrame(): Uint8Array {
  return galakuEncrypt([0x5A, 0, 0, 1, 0x13, 0, 0, 0, 0, 0])
}

/**
 * 迷路内置代码适配器工厂:galaku 一帧同时携带双通道强度,
 * 适配器需记住另一通道最近值(闭包状态;命令只描述单个功能)。
 * channelOf:功能 id → 通道号(0/1)。吮吸版通道语义为最佳推断,真机若颠倒调换映射即可。
 */
export function createMiluAdapter(manifest: ToyAdapterManifest, channelOf: Record<string, number>): ToyAdapter {
  const channelValues = [0, 0]
  return {
    manifest,
    buildFrames(cmd: NormalizedCommand): Uint8Array[] {
      const ch = channelOf[cmd.function]
      if (ch == null) return []
      channelValues[ch] = Math.max(0, Math.min(100, Math.round(cmd.intensity)))
      return [galakuDualChannelFrame(channelValues[0] ?? 0, channelValues[1] ?? 0)]
    },
    buildInitFrames(): Uint8Array[] {
      // galaku 无初始化握手;连接即控(设备接入时自震一下属固件行为)
      return []
    },
    buildStopFrames(): Uint8Array[] {
      channelValues[0] = 0
      channelValues[1] = 0
      return [galakuDualChannelFrame(0, 0)]
    }
  }
}
