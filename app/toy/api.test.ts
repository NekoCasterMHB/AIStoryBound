// app/toy/api.test.ts
// ToyController 调教(wave)引擎回归测试:
// 波形自身的 0 强度档(脉冲低电平等)不得终止调教;外部主动发 0 仍然停止调教。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DEFAULT_TOY_SETTINGS } from '#shared/toy'
import { analyzePluginDescriptor, capabilitiesToToyCaps } from '#shared/plugin'
import { toyController } from './api'
import { createMockTransport, type MockTransportInstance } from './transports/mock'
import { createMiluAdapter } from './builtin/milu/frames'
import { MILU_SUCKING_PLUGIN } from './builtin/milu/plugin'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** 停止帧(双通道 0,galaku 帧格式,见 milu/frames.test.ts) */
const STOP_FRAME = '23 81 bb ab d2 7b 44 33 bb a3 3b f2'

/** 生产同款路径构建吮吸版适配器(真实能力清单 → 可执行适配器) */
function buildSuckingAdapter() {
  const analyzed = analyzePluginDescriptor(MILU_SUCKING_PLUGIN)
  if (!analyzed.ok) throw new Error(analyzed.reason)
  const d = analyzed.spec.descriptor
  const rt = analyzed.spec.runtime as Extract<typeof analyzed.spec.runtime, { type: 'toy-code' }>
  return createMiluAdapter({
    id: d.id, name: d.name, version: d.version, scanNames: rt.scanNames,
    gatt: rt.gatt, battery: rt.battery, capabilities: capabilitiesToToyCaps(analyzed.spec.capabilities)
  }, { suction: 0, vibration: 1 })
}

test('调教不限时:脉冲低电平(强度 0)不终止调教,设备照常收到 0 档帧', async () => {
  const transport = createMockTransport()
  assert.equal((await toyController.connect(buildSuckingAdapter(), transport)).ok, true)
  // 周期 0.4s、占空 0.5:200ms 起进入低电平;观察 800ms 覆盖两个完整周期
  const r = await toyController.startWave('suction', [0, 100], {
    pattern: 'pulse', params: { periodSec: 0.4, duty: 0.5 }, intervalMs: 25, settings: DEFAULT_TOY_SETTINGS
  })
  assert.equal(r.ok, true)
  await sleep(800)
  assert.equal(toyController.isWaveActive('suction'), true, '波形 0 档不应终止调教')
  assert.ok(
    transport.state.writeLog.includes(STOP_FRAME),
    `低电平期间应写入 0 强度帧(日志:${JSON.stringify(transport.state.writeLog)})`
  )
  await toyController.disconnect()
})

test('调教进行中外部发强度 0 仍停止调教(原语义保留)', async () => {
  const transport: MockTransportInstance = createMockTransport()
  assert.equal((await toyController.connect(buildSuckingAdapter(), transport)).ok, true)
  const r = await toyController.startWave('suction', [0, 100], {
    pattern: 'constant', params: { level: 50 }, intervalMs: 25, settings: DEFAULT_TOY_SETTINGS
  })
  assert.equal(r.ok, true)
  await sleep(60)
  const stop = await toyController.execute({ function: 'suction', intensity: 0 }, { source: 'manual', settings: DEFAULT_TOY_SETTINGS })
  assert.equal(stop.ok, true)
  assert.equal(toyController.isWaveActive('suction'), false, '外部 0 强度指令应停止调教')
  assert.equal(transport.state.writeLog.at(-1), STOP_FRAME)
  await toyController.disconnect()
})
