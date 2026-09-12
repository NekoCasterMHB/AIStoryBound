// app/toy/builtin/milu/frames.test.ts
// 迷路(galaku 协议)帧构造与内置适配器单测:
// 加密/帧格式对 buttplug 官方测试向量逐字节锁定;适配器验证双通道合并与停止语义。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { analyzePluginDescriptor } from '#shared/plugin'
import { framesToHex } from '#shared/toy'
import { createMiluAdapter, galakuBatteryQueryFrame, galakuDualChannelFrame, galakuEncrypt } from './frames'
import { MILU_INSERTABLE_PLUGIN, MILU_SUCKING_PLUGIN } from './plugin'

async function hex(frames: Uint8Array[] | Promise<Uint8Array[]>): Promise<string> {
  return framesToHex(await frames).join(' ')
}

test('galakuEncrypt: 官方 GX21 单马达测试向量(vibrate 0%)', () => {
  // buttplug test_galaku.yaml: [0x23, 0x81, 0xBB, 0xAB, 0xD2, 0xEC, 0x3B, 0x23, 0xBB, 0xA3, 0x3B, 0x90]
  assert.equal(
    Array.from(galakuEncrypt([0x5A, 0, 0, 1, 0x31, 0, 0, 0, 0, 0])).map(b => b.toString(16)).join(' '),
    '23 81 bb ab d2 ec 3b 23 bb a3 3b 90'
  )
})

test('galakuEncrypt: 官方 GX21 单马达测试向量(vibrate 100%,校验和 >255 不预截断)', () => {
  // buttplug test_galaku.yaml: [0x23, 0x81, 0xBB, 0xAB, 0xD2, 0xEC, 0x57, 0x23, 0xBB, 0xA3, 0x3B, 0x44]
  assert.equal(
    Array.from(galakuEncrypt([0x5A, 0, 0, 1, 0x31, 100, 0, 0, 0, 0])).map(b => b.toString(16)).join(' '),
    '23 81 bb ab d2 ec 57 23 bb a3 3b 44'
  )
})

test('galakuDualChannelFrame: 双通道帧固定 12 字节、通道值独立携带', () => {
  const f = galakuDualChannelFrame(30, 70)
  assert.equal(f.length, 12)
  assert.equal(f[0], 0x23)
  // 同帧型(仅通道值不同)前 5 字节稳定(混淆链前段只依赖公共前缀)
  assert.deepEqual([...f.slice(0, 5)], [0x23, 0x81, 0xbb, 0xab, 0xd2])
})

test('galakuDualChannelFrame: 强度越界钳制 0-100', () => {
  const a = galakuDualChannelFrame(-5, 250)
  const b = galakuDualChannelFrame(0, 100)
  assert.deepEqual(Array.from(a), Array.from(b))
})

test('galakuBatteryQueryFrame: 电量查询帧(命令 0x13)与官方实现一致', async () => {
  // galaku.rs handle_battery_level_cmd: [90, 0, 0, 1, 19, 0, 0, 0, 0, 0]
  assert.equal(await hex([galakuBatteryQueryFrame()]), '23 81 bb ab d2 ce d3 23 bb a3 3b c2')
})

test('createMiluAdapter: 单功能命令携带双通道全量(另一通道保留最近值)', async () => {
  const adapter = createMiluAdapter(
    { id: 't', name: 't', version: '1' },
    { suction: 0, vibration: 1 }
  )
  // 吮吸 50:通道 1 尚为 0
  assert.equal(await hex(adapter.buildFrames({ function: 'suction', intensity: 50 })), '23 81 bb ab d2 7b 44 61 3b a3 3b e4')
  // 再震动脉冲 30:通道 0 保留 50
  assert.equal(await hex(adapter.buildFrames({ function: 'vibration', intensity: 30 })), '23 81 bb ab d2 7b 44 61 3d 43 3b 42')
})

test('createMiluAdapter: 停止帧双通道归零并复位内部状态', async () => {
  const adapter = createMiluAdapter(
    { id: 't', name: 't', version: '1' },
    { suction: 0, vibration: 1 }
  )
  await adapter.buildFrames({ function: 'suction', intensity: 80 })
  const stop = await adapter.buildStopFrames?.({}) ?? []
  assert.equal(stop.length, 1)
  assert.equal(await hex(stop), '23 81 bb ab d2 7b 44 33 bb a3 3b f2')
  // 停止后内部状态归零:再发震动命令,通道 0 不残留旧值
  assert.equal(await hex(adapter.buildFrames({ function: 'vibration', intensity: 40 })), '23 81 bb ab d2 7b 44 33 d3 a3 3b ca')
})

test('createMiluAdapter: 未知功能返回空帧(引擎层会拒绝)', () => {
  const adapter = createMiluAdapter(
    { id: 't', name: 't', version: '1' },
    { suction: 0 }
  )
  assert.deepEqual(adapter.buildFrames({ function: 'nope', intensity: 50 }), [])
})

test('迷路双插件清单通过平台强制校验(toy-code + gatt + 能力声明)', () => {
  for (const d of [MILU_SUCKING_PLUGIN, MILU_INSERTABLE_PLUGIN]) {
    const v = analyzePluginDescriptor(d)
    assert.equal(v.ok, true, `插件 ${d.id} 校验失败:${v.ok ? '' : v.reason}`)
    if (v.ok) {
      assert.equal(v.spec.runtime.type, 'toy-code')
      const caps = v.spec.capabilities
      for (const cap of caps) {
        const intensity = cap.params.find(p => p.key === 'intensity')
        assert.ok(intensity && intensity.type === 'int' && intensity.max === 100)
      }
    }
  }
})
