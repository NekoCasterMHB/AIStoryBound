// scripts/demo/mvp3-device.mts
// 玩具控制 MVP 验收脚本(Node/tsx 运行,无浏览器、无硬件):
//   1. 帧构造断言:对照三源逆向文档的协议示例(51enuxu / ktktktkt1234 / funf-pro-relay)
//   2. 校验链:validateDeviceEvent(能力/范围) + checkHardLimits(硬限制) + 冷却
//   3. 端到端(真实 ToyApi + Mock 传输):连接 → 初始化帧 → 控制 → 计时自动停止 → 紧急停止 → 断连
//
// 用法: pnpm demo:toy   (或 pnpm exec tsx scripts/demo/mvp3-device.mts)
// 全部断言通过输出 PASS 并以 0 退出;任一失败输出 FAIL 并以非 0 退出。
import { readFileSync } from 'node:fs'
import {
  buildProtocolControlFrame,
  buildProtocolInitFrame,
  buildProtocolStopFrames,
  checkHardLimits,
  createProtocolAdapter,
  DEFAULT_TOY_SETTINGS,
  framesToHex,
  pickWaveTarget,
  randomTrainParams,
  randomTrainPattern,
  repickWaveTarget,
  stepToward,
  trainPatternValue,
  validateDeviceEvent
} from '../../shared/toy'
import { mockTransport, mockTransportState, mockForceDisconnect } from '../../app/toy/transports/mock'
import { toyController } from '../../app/toy/api'

const protocol = JSON.parse(readFileSync(new URL('../../app/toy/builtin/sosexy/protocol.json', import.meta.url), 'utf-8'))

let passCount = 0
let failCount = 0

function assertEq(name: string, actual: string[], expected: string[]): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passCount++
    console.log(`  ✓ ${name}`)
  } else {
    failCount++
    console.error(`  ✗ ${name}\n    期望: ${e}\n    实际: ${a}`)
  }
}

function assertOk(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passCount++
    console.log(`  ✓ ${name}`)
  } else {
    failCount++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 帧日志中是否存在以给定后缀结尾的帧(SEQ 随机,只比对 SEQ 之后的确定性部分) */
function logHasSuffix(suffix: string): boolean {
  return mockTransportState.writeLog.some(l => l.endsWith(suffix))
}

/** 确定性 rng:循环消费给定序列(波浪测试注入用) */
function seqRng(seq: number[]): () => number {
  let i = 0
  return () => seq[i++ % seq.length]
}

console.log('\n[1/4] 帧构造(对照协议文档示例,固定 SEQ=0x01)')
{
  const suction = framesToHex([buildProtocolControlFrame(protocol, 'suction', 50, { seq: 1 })!])
  assertEq('吮吸 50% → 01 01 00 02 00 07 11 32 00 08 11 01', suction, ['01 01 00 02 00 07 11 32 00 08 11 01'])
  const vibe = framesToHex([buildProtocolControlFrame(protocol, 'vibration', 30, { seq: 1 })!])
  assertEq('震动 30% → 01 01 00 02 00 01 11 1e 00 02 11 01', vibe, ['01 01 00 02 00 01 11 1e 00 02 11 01'])
  const electric = framesToHex([buildProtocolControlFrame(protocol, 'electric', 20, { seq: 1 })!])
  assertEq('电流 20% → 01 01 00 02 00 03 11 14 00 04 11 01', electric, ['01 01 00 02 00 03 11 14 00 04 11 01'])
  const init = framesToHex([buildProtocolInitFrame(protocol, 1)!])
  assertEq('初始化帧 → 01 01 00 01 00 c8 11 01', init, ['01 01 00 01 00 c8 11 01'])
  const stops = framesToHex(buildProtocolStopFrames(protocol, { suction: { mode: 2 }, vibration: { mode: 1 }, electric: { mode: 3 } }, { seq: 1 }))
  assertEq('停止帧 = 各功能强度归零、模式保留', stops, [
    '01 01 00 02 00 07 11 00 00 08 11 02',
    '01 01 00 02 00 01 11 00 00 02 11 01',
    '01 01 00 02 00 03 11 00 00 04 11 03'
  ])
  const unknown = buildProtocolControlFrame(protocol, 'nope', 50)
  assertOk('未知功能 → 无帧', unknown === null)
}

console.log('\n[2/4] 结构性校验 validateDeviceEvent(能力检查 + 钳制)')
const adapter = createProtocolAdapter(protocol, {
  id: 'sosexy',
  name: '啵啵贝 (FUNF SOSEXY)',
  version: '1.0.0',
  scanNames: ['SOSEXY'],
  functionNames: { suction: '吮吸', vibration: '震动', electric: '微电流' }
})
const caps = adapter.manifest.capabilities!
{
  const ok = validateDeviceEvent({ function: 'suction', intensity: 50, mode: 2, duration: 10 }, caps)
  assertOk('合法事件通过', ok.ok, ok.ok ? '' : ok.reason)
  const badFn = validateDeviceEvent({ function: 'rotate', intensity: 50 }, caps)
  assertOk('未知功能被拒(超能力)', !badFn.ok, badFn.ok ? '' : badFn.reason)
  const clamp = validateDeviceEvent({ function: 'suction', intensity: 250, mode: 9 }, caps)
  assertOk('强度 250 钳制到 100', clamp.ok && clamp.event.intensity === 100, clamp.ok ? `实际 ${clamp.event.intensity}` : clamp.reason)
  assertOk('模式 9 钳制到 4', clamp.ok && clamp.event.mode === 4, clamp.ok ? `实际 ${clamp.event.mode}` : clamp.reason)
  const badType = validateDeviceEvent({ function: 'suction', intensity: '强' }, caps)
  assertOk('强度非数字被拒', !badType.ok, badType.ok ? '' : badType.reason)
}

console.log('\n[3/4] 硬限制 checkHardLimits + 冷却')
{
  const s = { ...DEFAULT_TOY_SETTINGS, aiEnabled: false }
  const gate = checkHardLimits({ function: 'suction', intensity: 30 }, s, 'ai')
  assertOk('AI 总开关关闭 → 拒绝', !gate.ok, gate.ok ? '' : gate.reason)

  const s2 = { ...DEFAULT_TOY_SETTINGS, aiEnabled: true, maxDuration: 30, functionLimits: { suction: { maxIntensity: 50 } } }
  const over = checkHardLimits({ function: 'suction', intensity: 80 }, s2, 'ai')
  assertOk('强度 80 > 上限 50 → 拒绝', !over.ok, over.ok ? '' : over.reason)
  const long = checkHardLimits({ function: 'suction', intensity: 30, duration: 60 }, s2, 'ai')
  assertOk('时长 60s > 上限 30s → 拒绝', !long.ok, long.ok ? '' : long.reason)
  const manual = checkHardLimits({ function: 'suction', intensity: 30 }, s2, 'manual')
  assertOk('手动控制不受 AI 开关限制', manual.ok, manual.ok ? '' : manual.reason)

  // 分能力单独启用:仅放行列表内功能
  const s3 = { ...s2, aiEnabledFunctions: ['vibration'] }
  const fnGate = checkHardLimits({ function: 'suction', intensity: 30 }, s3, 'ai')
  assertOk('功能未开启 AI 控制 → 拒绝', !fnGate.ok, fnGate.ok ? '' : fnGate.reason)
  const fnOk = checkHardLimits({ function: 'vibration', intensity: 30 }, s3, 'ai')
  assertOk('功能在 AI 允许列表内 → 通过', fnOk.ok, fnOk.ok ? '' : fnOk.reason)

  // 按能力单独限制:只影响对应功能
  const s4 = { ...s2, functionLimits: { suction: { maxIntensity: 50 }, vibration: { maxIntensity: 20 } } }
  const fnOver = checkHardLimits({ function: 'vibration', intensity: 30 }, s4, 'ai')
  assertOk('能力覆盖:震动上限 20 → 强度 30 拒绝', !fnOver.ok, fnOver.ok ? '' : fnOver.reason)
  const fnUnder = checkHardLimits({ function: 'vibration', intensity: 15 }, s4, 'ai')
  assertOk('能力覆盖:震动上限 20 → 强度 15 通过', fnUnder.ok, fnUnder.ok ? '' : fnUnder.reason)
  const otherFn = checkHardLimits({ function: 'suction', intensity: 80 }, s4, 'ai')
  assertOk('未覆盖能力沿用自身上限 50 → 强度 80 拒绝', !otherFn.ok, otherFn.ok ? '' : otherFn.reason)

  // 未单独设置的能力:初始默认 100
  const s5 = { ...DEFAULT_TOY_SETTINGS, aiEnabled: true, maxDuration: 30 }
  const dfltOk = checkHardLimits({ function: 'suction', intensity: 80 }, s5, 'ai')
  assertOk('未设置能力默认上限 100 → 强度 80 通过', dfltOk.ok, dfltOk.ok ? '' : dfltOk.reason)
  const dfltOver = checkHardLimits({ function: 'suction', intensity: 101 }, s5, 'ai')
  assertOk('未设置能力默认上限 100 → 强度 101 拒绝', !dfltOver.ok, dfltOver.ok ? '' : dfltOver.reason)
}

console.log('\n[3.5] 调教目标驱动 stepToward(纯函数)')
{
  // 朝目标收敛:从 20 出发,目标 90,50 步内应接近目标
  let v = 20
  for (let i = 0; i < 50; i++) v = stepToward(v, 90, [10, 100], { stepMax: 8 })
  assertOk('50 步内从 20 收敛到目标 90 附近(≥80)', v >= 80, `实际 ${v}`)
  // 徘徊:到达目标附近后在其周围小幅波动,不越界
  let p = 90
  let ok = true
  for (let i = 0; i < 100; i++) {
    const next = stepToward(p, 90, [10, 100], { stepMax: 8 })
    if (next < 10 || next > 100 || Math.abs(next - p) > 12) {
      ok = false
      break
    }
    p = next
  }
  assertOk('目标附近 100 步徘徊不越界且平滑', ok)
  // 下边界反弹
  const down = stepToward(12, 10, [10, 100], { stepMax: 8, rng: () => 0 })
  assertOk('下边界反弹', down >= 10, `实际 ${down}`)
}

console.log('\n[3.6] 调教双姿态目标抽取 pickWaveTarget(纯函数)')
{
  // 首次抽取:rng<0.5 → sweep 姿态;全范围目标(91);步长小(缓慢扫动)
  const p1 = pickWaveTarget(50, [10, 100], undefined, seqRng([0.1, 0.9, 0.1, 0.9]))
  assertOk('首次抽取:随机到 sweep 姿态', p1.regime === 'sweep', `实际 ${p1.regime}`)
  assertOk('sweep 目标在全范围(91)', p1.target === 91, `实际 ${p1.target}`)
  assertOk('sweep 步长小(缓慢扫动)', p1.stepMax === 6, `实际 ${p1.stepMax}`)
  assertOk('sweep 保持时长随机 6-15s', p1.dwellMs === 6900, `实际 ${p1.dwellMs}`)
  // 目标抽到近处(<span/3)会被推到远端,保证大跨度
  const p2 = pickWaveTarget(50, [10, 100], p1, seqRng([0.1, 0.5, 0.1, 0.9]))
  assertOk('近处目标被推到远端(99)', p2.target === 99, `实际 ${p2.target}`)
  // flutter:窗口中心固定,目标在 ±15% span 内;步长大(快速起伏)
  const p3 = pickWaveTarget(50, [10, 100], { ...p1, regime: 'flutter', center: 40, target: 51, stepMax: 9, dwellMs: 2000 }, seqRng([0.1, 0.9, 0.1]))
  assertOk('flutter 保持姿态', p3.regime === 'flutter', `实际 ${p3.regime}`)
  assertOk('flutter 窗口中心固定(40)', p3.center === 40, `实际 ${p3.center}`)
  assertOk('flutter 目标在 ±15% 窗口内(51)', p3.target === 51, `实际 ${p3.target}`)
  assertOk('flutter 步长大(快速起伏)', p3.stepMax === 9, `实际 ${p3.stepMax}`)
  // 姿态切换:65% 概率切到另一种
  const p4 = pickWaveTarget(50, [10, 100], p3, seqRng([0.5, 0.9, 0.1]))
  assertOk('flutter → 高概率切到 sweep', p4.regime === 'sweep', `实际 ${p4.regime}`)
  // 抵达后重抽:保持姿态与窗口,换目标继续运动
  const r1 = repickWaveTarget(51, [10, 100], p3, seqRng([0.9, 0.1]))
  assertOk('重抽保持 flutter 姿态', r1.regime === 'flutter', `实际 ${r1.regime}`)
  assertOk('重抽仍在同一窗口内(51)', r1.target === 51 && r1.center === 40, `实际 目标 ${r1.target} 中心 ${r1.center}`)
  const r2 = repickWaveTarget(90, [10, 100], p1, seqRng([0.5, 0.1]))
  assertOk('sweep 重抽继续大跨度扫动(55)', r2.regime === 'sweep' && r2.target === 55, `实际 ${r2.regime} 目标 ${r2.target}`)
}

console.log('\n[3.7] 调教形态波形 trainPatternValue(纯函数)')
{
  const range: [number, number] = [10, 100]
  // 正弦:中心 55、振幅 ±45;t=0 中心,t=周期/4 顶,t=周期/2 底
  assertOk('正弦 t=0 在中心(55)', trainPatternValue('sine', 0, { periodSec: 4 }, range) === 55)
  assertOk('正弦 t=周期/4 到顶(100)', trainPatternValue('sine', 1, { periodSec: 4 }, range) === 100)
  assertOk('正弦 t=3/4 周期到底(10)', trainPatternValue('sine', 3, { periodSec: 4 }, range) === 10)
  assertOk('正弦振幅 50% 只到 77.5', trainPatternValue('sine', 1, { periodSec: 4, amplitude: 50 }, range) === 78, `实际 ${trainPatternValue('sine', 1, { periodSec: 4, amplitude: 50 }, range)}`)
  // 锯齿:周期 2s,线性渐强(相位 25% → 33)
  assertOk('锯齿渐强(相位 25% → 33)', trainPatternValue('sawtooth', 0.5, { periodSec: 2 }, range) === 33, `实际 ${trainPatternValue('sawtooth', 0.5, { periodSec: 2 }, range)}`)
  assertOk('锯齿接近到顶(相位 95% → 96)', trainPatternValue('sawtooth', 1.9, { periodSec: 2 }, range) === 96, `实际 ${trainPatternValue('sawtooth', 1.9, { periodSec: 2 }, range)}`)
  // 脉冲:占空比 40% 内高电平(100),其余 0
  assertOk('脉冲高电平相位(100)', trainPatternValue('pulse', 0.1, { periodSec: 1, duty: 0.4 }, range) === 100)
  assertOk('脉冲低电平相位(0)', trainPatternValue('pulse', 0.5, { periodSec: 1, duty: 0.4 }, range) === 0)
  // 心跳:每周期两拍(相位 <8% 与 22%-30%),其余 0
  assertOk('心跳第一拍(100)', trainPatternValue('heartbeat', 0.1, { periodSec: 2 }, range) === 100)
  assertOk('心跳两拍之间(0)', trainPatternValue('heartbeat', 0.3, { periodSec: 2 }, range) === 0)
  assertOk('心跳第二拍(100)', trainPatternValue('heartbeat', 0.5, { periodSec: 2 }, range) === 100)
  // 恒定:保持 level
  assertOk('恒定保持 level(70)', trainPatternValue('constant', 5, { level: 70 }, range) === 70)
  // auto 随机抽取:rng 0.9 → 恒定;0.1 → 正弦
  assertOk('随机形态 rng=0.9 → 恒定', randomTrainPattern(seqRng([0.9])) === 'constant', `实际 ${randomTrainPattern(seqRng([0.9]))}`)
  assertOk('随机形态 rng=0.1 → 正弦', randomTrainPattern(seqRng([0.1])) === 'sine', `实际 ${randomTrainPattern(seqRng([0.1]))}`)
  const rp = randomTrainParams('sine', range, seqRng([0.5]))
  assertOk('随机参数:正弦周期 6-14s', rp.periodSec === 10, `实际 ${rp.periodSec}`)
}

console.log('\n[4/4] 端到端(真实 ToyApi + Mock 传输):连接 → 初始化 → 控制 → 自动停止 → 紧急停止 → 断连')
{
  const settings = { ...DEFAULT_TOY_SETTINGS, aiEnabled: true, maxDuration: 30 }

  // 连接:mock 扫描 → 连接 → 初始化帧
  const connected = await toyController.connect(adapter, mockTransport, { waitInitMs: 0 })
  assertOk('连接成功', connected.ok, connected.ok ? '' : connected.reason)
  assertOk('模拟设备已连接', toyController.state.connected)
  assertOk('初始化帧已发送(01 00 01 00 c8 11 01)', logHasSuffix('01 00 01 00 c8 11 01'), mockTransportState.writeLog.join('\n'))

  // 吮吸 50%、时长 1 秒(到时自动停止)
  const r1 = await toyController.execute({ function: 'suction', intensity: 50, mode: 1, duration: 1 }, { source: 'ai', settings })
  assertOk('AI 指令:吮吸 50% 通过', r1.ok, r1.ok ? '' : r1.reason)
  assertOk('控制帧已下发(…07 11 32 00 08 11 01)', logHasSuffix('01 00 02 00 07 11 32 00 08 11 01'), mockTransportState.writeLog.join('\n'))

  // AI 开关关闭 → 拒绝(即使已连接)
  const r2 = await toyController.execute({ function: 'vibration', intensity: 30 }, { source: 'ai', settings: { ...settings, aiEnabled: false } })
  assertOk('AI 总开关关闭 → 拒绝', !r2.ok, r2.ok ? '' : r2.reason)

  // 超能力 → 拒绝
  const r3 = await toyController.execute({ function: 'rotate', intensity: 30 }, { source: 'ai', settings })
  assertOk('超能力(rotate)→ 拒绝', !r3.ok, r3.ok ? '' : r3.reason)

  // 超限 → 拒绝(electric 按能力上限 50)
  const r4 = await toyController.execute({ function: 'electric', intensity: 80 }, { source: 'ai', settings: { ...settings, functionLimits: { electric: { maxIntensity: 50 } } } })
  assertOk('强度 80 > electric 上限 50 → 拒绝', !r4.ok, r4.ok ? '' : r4.reason)

  // 路由:指定其他适配器(未连接)→ 拒绝
  const r5 = await toyController.execute({ adapter: 'other-brand', function: 'suction', intensity: 30 }, { source: 'ai', settings })
  assertOk('目标设备未连接 → 拒绝', !r5.ok, r5.ok ? '' : r5.reason)
  // 指定当前连接适配器 → 通过
  const r6 = await toyController.execute({ adapter: 'sosexy', function: 'vibration', intensity: 20, duration: 1 }, { source: 'ai', settings })
  assertOk('显式指定当前连接设备 → 通过', r6.ok, r6.ok ? '' : r6.reason)

  // 调教模式:两种姿态随机交替——sweep 大幅缓慢波动 + flutter 一定范围快速上下波动(范围 10-100,快速 tick 验证)
  // 第一轮:首抽 sweep(目标 91),1.2s 内从 20 慢速扫向 91 → 大跨度移动
  const logStart1 = mockTransportState.writeLog.length
  const sweepRng = seqRng([0.1, 0.9, 0.9, ...Array(40).fill(0.5)])
  const w1 = await toyController.startWave('vibration', [10, 100], { intervalMs: 60, settings, rng: sweepRng })
  assertOk('调教启动', w1.ok, w1.ok ? '' : w1.reason)
  assertOk('调教状态标记', toyController.isWaveActive('vibration'))
  assertOk('首轮姿态为 sweep(大幅缓慢波动)', toyController.waveRegimeOf('vibration') === 'sweep', `实际 ${toyController.waveRegimeOf('vibration')}`)
  await new Promise(r => setTimeout(r, 1200))
  assertOk('调教期间持续下发帧', mockTransportState.writeLog.length > logStart1)
  // 回归:多次 tick 的 execute 不应抹掉调教激活态(曾导致"点击无法停止")
  assertOk('多次 tick 后调教仍激活', toyController.isWaveActive('vibration'))
  // 解析调教帧强度:帧格式 ... 01 11 [INT] 00 02 11 01,强度=第 8 字节(索引 7)
  const waveIntensities = mockTransportState.writeLog
    .slice(logStart1)
    .filter(l => l.endsWith('00 02 11 01') && l.split(' ')[5] === '01')
    .map(l => parseInt(l.split(' ')[7], 16))
    .filter(v => Number.isFinite(v) && v > 0)
  assertOk('调教帧强度均在 10-100 范围内', waveIntensities.every(v => v >= 10 && v <= 100), `样本:${waveIntensities.slice(-6).join(',')}`)
  assertOk('sweep 大幅缓慢扫动(跨度 >30)', Math.max(...waveIntensities) - Math.min(...waveIntensities) > 30, `样本:${waveIntensities.slice(-6).join(',')}`)
  toyController.stopWave('vibration')
  assertOk('调教停止后状态清除', !toyController.isWaveActive('vibration'))

  // 第二轮:flutter 姿态(窗口中心 40,目标 51),快速在固定窗口内起伏 → 幅度有界、有移动
  await toyController.execute({ function: 'vibration', intensity: 40 }, { source: 'manual', settings })
  const logStart2 = mockTransportState.writeLog.length
  const flutterRng = seqRng([0.6, 0.9, 0.1, 0.9, 0.1])
  const w2 = await toyController.startWave('vibration', [10, 100], { intervalMs: 60, settings, rng: flutterRng })
  assertOk('第二轮调教启动', w2.ok, w2.ok ? '' : w2.reason)
  assertOk('第二轮姿态为 flutter(局部快速起伏)', toyController.waveRegimeOf('vibration') === 'flutter', `实际 ${toyController.waveRegimeOf('vibration')}`)
  await new Promise(r => setTimeout(r, 500))
  const flutterIntensities = mockTransportState.writeLog
    .slice(logStart2)
    .filter(l => l.endsWith('00 02 11 01') && l.split(' ')[5] === '01')
    .map(l => parseInt(l.split(' ')[7], 16))
    .filter(v => Number.isFinite(v) && v > 0)
  assertOk('flutter 幅度有界(≤65,未全范围扫动)', Math.max(...flutterIntensities) <= 65, `样本:${flutterIntensities.slice(-6).join(',')}`)
  assertOk('flutter 存在快速移动(跨度 ≥4)', Math.max(...flutterIntensities) - Math.min(...flutterIntensities) >= 4, `样本:${flutterIntensities.slice(-6).join(',')}`)
  toyController.stopWave('vibration')
  assertOk('第二轮停止后状态清除', !toyController.isWaveActive('vibration'))

  // 第三轮:正弦波形(周期 4s):平滑周期波动,跨度覆盖大半范围
  const logStart3 = mockTransportState.writeLog.length
  const w3 = await toyController.startWave('vibration', [10, 100], { pattern: 'sine', params: { periodSec: 4 }, intervalMs: 60, settings })
  assertOk('第三轮调教启动(正弦)', w3.ok, w3.ok ? '' : w3.reason)
  assertOk('形态为 sine', toyController.wavePatternOf('vibration') === 'sine', `实际 ${toyController.wavePatternOf('vibration')}`)
  await new Promise(r => setTimeout(r, 1200))
  const sineIntensities = mockTransportState.writeLog
    .slice(logStart3)
    .filter(l => l.endsWith('00 02 11 01') && l.split(' ')[5] === '01')
    .map(l => parseInt(l.split(' ')[7], 16))
    .filter(v => Number.isFinite(v) && v > 0)
  assertOk('正弦强度均在 10-100 范围内', sineIntensities.every(v => v >= 10 && v <= 100), `样本:${sineIntensities.slice(-6).join(',')}`)
  assertOk('正弦跨度覆盖大半范围(>30)', Math.max(...sineIntensities) - Math.min(...sineIntensities) > 30, `样本:${sineIntensities.slice(-6).join(',')}`)
  toyController.stopWave('vibration')

  // 第四轮:脉冲节拍(周期 1s,占空比 40%):高电平 100 与停止 0 交替
  const logStart4 = mockTransportState.writeLog.length
  const w4 = await toyController.startWave('vibration', [10, 100], { pattern: 'pulse', params: { periodSec: 1, duty: 0.4 }, intervalMs: 60, settings })
  assertOk('第四轮调教启动(脉冲)', w4.ok, w4.ok ? '' : w4.reason)
  await new Promise(r => setTimeout(r, 800))
  const pulseIntensities = mockTransportState.writeLog
    .slice(logStart4)
    .filter(l => l.endsWith('00 02 11 01') && l.split(' ')[5] === '01')
    .map(l => parseInt(l.split(' ')[7], 16))
    .filter(v => Number.isFinite(v))
  assertOk('脉冲同时出现高电平与停止', pulseIntensities.some(v => v >= 90) && pulseIntensities.some(v => v === 0), `样本:${pulseIntensities.slice(-8).join(',')}`)
  toyController.stopWave('vibration')

  // 第五轮:全随机(autoSwitchMs 300ms):首轮抽到恒定(起始强度 40),到期轮换到正弦
  await toyController.execute({ function: 'vibration', intensity: 40 }, { source: 'manual', settings })
  const autoRng = seqRng([0.9, 0.1, 0.9, 0.5, 0.5])
  const w5 = await toyController.startWave('vibration', [10, 100], { pattern: 'auto', autoSwitchMs: 300, intervalMs: 60, settings, rng: autoRng })
  assertOk('第五轮调教启动(全随机)', w5.ok, w5.ok ? '' : w5.reason)
  assertOk('全随机首轮形态为恒定(level=起始强度)', toyController.wavePatternOf('vibration') === 'constant', `实际 ${toyController.wavePatternOf('vibration')}`)
  await new Promise(r => setTimeout(r, 600))
  assertOk('到期轮换到新形态(正弦)', toyController.wavePatternOf('vibration') === 'sine', `实际 ${toyController.wavePatternOf('vibration')}`)
  assertOk('轮换后调教仍激活', toyController.isWaveActive('vibration'))
  toyController.stopWave('vibration')
  assertOk('第五轮停止后状态清除', !toyController.isWaveActive('vibration'))

  // 等待计时自动停止(1s 时长到期 → 吮吸强度归零帧)
  await new Promise(r => setTimeout(r, 1500))
  assertOk(
    '时长到期自动停止(吮吸强度归零)',
    logHasSuffix('01 00 02 00 07 11 00 00 08 11 01'),
    mockTransportState.writeLog.join('\n')
  )

  // 紧急停止:三个功能全停(强度归零、模式保留)
  const before = mockTransportState.writeLog.length
  await toyController.emergencyStop()
  assertOk('紧急停止补发 3 条停止帧', mockTransportState.writeLog.length >= before + 3, `新增 ${mockTransportState.writeLog.length - before} 帧`)
  assertOk('全停后状态强度归零', Object.values(toyController.state.functions).every(f => f.intensity === 0))

  // 已授权设备直连路径:免扫描,指定设备对象直接连接(对应 Web Bluetooth getDevices 列表点选)
  const re = await toyController.connect(adapter, mockTransport, { device: { id: 'mock-sosexy', name: '模拟啵啵贝 (Mock)' } })
  assertOk('已授权设备直连成功(免扫描)', re.ok, re.ok ? '' : re.reason)
  assertOk('直连后初始化帧已发送', logHasSuffix('01 00 01 00 c8 11 01'), mockTransportState.writeLog.join('\n'))
  assertOk('直连后设备名正确', toyController.state.deviceName === '模拟啵啵贝 (Mock)', `实际 ${toyController.state.deviceName}`)

  // 断连:状态清除(断连自动停止由 onDisconnect 触发,浏览器真机路径)
  mockForceDisconnect()
  assertOk('断连后控制器状态复位', !toyController.state.connected && Object.keys(toyController.state.functions).length === 0)
}

console.log(`\n结果: ${passCount} 通过 / ${failCount} 失败`)
if (failCount > 0) process.exit(1)
console.log('PASS — 玩具控制 MVP 验收通过(真机验证需在浏览器设备面板进行)')
