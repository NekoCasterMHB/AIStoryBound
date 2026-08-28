// scripts/demo/plugin-stream.mts
// 通用插件能力描述 + 流式剧本编排验收脚本(Node/tsx 运行,无浏览器):
//   1. 强制格式分析器:合法清单通过;缺 uuid / 缺电量 / 缺每功能指令 / 缺 capabilities /
//      缺强度上限 / 强度超帧范围 → 均被拒并给出具体缺项
//   2. 能力 → AI 清单(describePlugin:强度范围暴露)
//   3. 流式解析器(narrStream):跨 chunk 指令、非法指令静默丢弃、未闭合指令流结束丢弃
//   4. 打字机(typewriter):限速显示 + 标点停顿 + 指令到句执行 + 自动会话回调 + flush
//
// 用法: pnpm exec tsx scripts/demo/plugin-stream.mts
// 全部断言通过输出 PASS 并以 0 退出;任一失败输出 FAIL 并以非 0 退出。
import { analyzePluginDescriptor, describePlugin } from '../../shared/plugin'
import type { PluginDescriptor } from '../../shared/plugin'
import { createNarrParser } from '../../app/utils/narrStream'
import { createTypewriter } from '../../app/utils/typewriter'

let passCount = 0
let failCount = 0

function assertOk(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passCount++
    console.log(`  ✓ ${name}`)
  } else {
    failCount++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const validManifest: PluginDescriptor = {
  id: 'demo-toys',
  name: '示例玩具 (DemoFun)',
  version: '1.0.0',
  runtime: {
    type: 'toy-protocol',
    scanNames: ['DEMOFUN'],
    protocol: {
      gatt: {
        serviceUuid: '0000ff01-0000-1000-8000-00805f9b34fb',
        writeUuid: '0000ff03-0000-1000-8000-00805f9b34fb',
        notifyUuid: '0000ff02-0000-1000-8000-00805f9b34fb'
      },
      battery: { supported: true },
      frame: { template: ['0xAA', '[SEQ]', '[MODE1]', '[INTENSITY]', '[MODE2]', '[MODE]'], intensityRange: [0, 100], modeRange: [1, 4] },
      functions: { vibration: { mode1: '0x01', mode2: '0x02', supportsMode: true } }
    }
  },
  capabilities: [
    {
      id: 'vibration',
      name: '震动',
      description: '震动强度控制。',
      params: [
        { key: 'intensity', type: 'int', min: 0, max: 100, description: '强度' },
        { key: 'mode', type: 'enum', values: [1, 2, 3, 4].map(v => ({ value: v, label: `档位 ${v}` })) },
        { key: 'duration', type: 'int', min: 0, max: 3600 }
      ]
    }
  ]
}

console.log('\n[1/4] 强制格式分析器 analyzePluginDescriptor')
{
  const ok = analyzePluginDescriptor(validManifest)
  assertOk('合法清单通过', ok.ok, ok.ok ? '' : (ok as { reason: string }).reason)
  if (ok.ok) {
    assertOk('ui 缺省生成默认布局(每能力一组)', ok.spec.uiSchema.groups.length === 1 && ok.spec.uiSchema.groups[0]?.controls.length === 3)
    assertOk('intensity 下限归一化为 0', ok.spec.capabilities[0]?.params.find(p => p.key === 'intensity')?.min === 0)
  }

  const missingCaps = analyzePluginDescriptor({ ...validManifest, capabilities: undefined })
  assertOk('缺 capabilities → 拒绝', !missingCaps.ok, (missingCaps as { reason: string }).reason)

  /** 克隆清单并覆写 toy-protocol 的 protocol 字段(构造缺项用例) */
  function withProtocol(manifest: PluginDescriptor, patch: Record<string, unknown>): PluginDescriptor {
    const rt = manifest.runtime
    if (!rt || rt.type !== 'toy-protocol') return manifest
    return { ...manifest, runtime: { ...rt, protocol: { ...rt.protocol, ...patch } } }
  }

  const missingGatt = analyzePluginDescriptor(withProtocol(validManifest, { gatt: undefined }))
  assertOk('缺 gatt uuid → 拒绝', !missingGatt.ok, (missingGatt as { reason: string }).reason)

  const missingBattery = analyzePluginDescriptor(withProtocol(validManifest, { battery: undefined }))
  assertOk('缺 battery 电量查询 → 拒绝', !missingBattery.ok, (missingBattery as { reason: string }).reason)

  const missingFunctions = analyzePluginDescriptor(withProtocol(validManifest, { functions: undefined }))
  assertOk('缺每功能指令 → 拒绝', !missingFunctions.ok, (missingFunctions as { reason: string }).reason)

  const missingIntensity = analyzePluginDescriptor({
    ...validManifest,
    capabilities: [{
      id: 'vibration',
      name: '震动',
      description: 'x',
      params: [{ key: 'mode', type: 'enum', values: [{ value: 1, label: '1' }] }]
    }]
  })
  assertOk('缺强度上限(intensity.max)→ 拒绝', !missingIntensity.ok, (missingIntensity as { reason: string }).reason)

  const overFrame = analyzePluginDescriptor({
    ...validManifest,
    capabilities: [{
      id: 'vibration',
      name: '震动',
      description: 'x',
      params: [{ key: 'intensity', type: 'int', min: 0, max: 120 }]
    }]
  })
  assertOk('强度上限超帧范围 → 拒绝', !overFrame.ok, (overFrame as { reason: string }).reason)

  const badRuntime = analyzePluginDescriptor({ ...validManifest, runtime: { type: 'nope' } })
  assertOk('runtime.type 非法 → 拒绝', !badRuntime.ok, (badRuntime as { reason: string }).reason)
}

console.log('\n[2/4] 能力 → AI 清单 describePlugin(强度范围暴露)')
{
  const v = analyzePluginDescriptor(validManifest)
  if (v.ok) {
    const brief = describePlugin(v.spec, true)
    assertOk('能力清单含强度范围 [0,100]', brief.capabilities[0]?.intensityRange[1] === 100)
    assertOk('能力清单含模式档位数 4', brief.capabilities[0]?.modeCount === 4 && brief.capabilities[0]?.supportsMode)
    assertOk('连接状态标注', brief.connected === true)
  } else {
    assertOk('能力清单(前置分析失败)', false, v.reason)
  }
}

console.log('\n[3/4] 流式解析器 narrStream(增量/跨 chunk/容错)')
{
  const p = createNarrParser()
  // 跨 chunk:指令被拆成两段到达
  const t1 = p.feed('她蜷起身子。[[dev:vibrat')
  assertOk('正文先出', t1.length === 1 && t1[0]?.type === 'text' && t1[0].text.includes('她蜷起身子'))
  const t2 = p.feed('ion:80:2:5]]呼吸渐促。')
  assertOk('跨 chunk 指令拼合', t2.some(t => t.type === 'device' && t.function === 'vibration' && t.intensity === 80 && t.mode === 2 && t.duration === 5))
  assertOk('指令后正文继续', t2.some(t => t.type === 'text' && t.text === '呼吸渐促。'))

  const p2 = createNarrParser()
  const bad = p2.feed('他说。[[dev:not-a-number:abc]]继续。[[pause:800]]')
  assertOk('非法指令静默丢弃', !bad.some(t => t.type === 'device'))
  assertOk('pause 指令解析', bad.some(t => t.type === 'pause' && t.ms === 800))

  const p4 = createNarrParser()
  const w = p4.feed('她喘息。[[wave:vibration:sine:10]]随后[[stop:vibration]]。')
  assertOk('wave 指令解析(含时长)', w.some(t => t.type === 'wave' && t.function === 'vibration' && t.pattern === 'sine' && t.duration === 10))
  assertOk('stop 指令解析', w.some(t => t.type === 'stop' && t.function === 'vibration'))

  const p3 = createNarrParser()
  const pre = p3.feed('未闭合 [[dev:vibration')
  assertOk('未闭合指令前正文先出', pre.length === 1 && pre[0]?.type === 'text' && pre[0].text === '未闭合 ')
  const tail = p3.finish()
  assertOk('流结束未闭合指令丢弃(finish 无残留)', tail.length === 0, `实际 ${JSON.stringify(tail)}`)
}

console.log('\n[4/4] 打字机 typewriter(限速/停顿/指令到句/自动会话/flush)')
{
  // 快速 cps 下文字立即上屏;指令到句执行且指令不可见
  const executed: string[] = []
  let autoStarted = 0
  let display = ''
  const tw = createTypewriter({
    cps: 1000,
    pauseScale: 0,
    onDisplay: (t) => { display = t },
    onExecute: (cmd) => {
      executed.push(`${cmd.function}:${cmd.intensity}`)
      return true
    },
    onAutoStart: () => { autoStarted++ },
    onAutoEnd: () => {}
  })
  tw.push([
    { type: 'text', text: '她蜷起身子。' },
    { type: 'device', function: 'vibration', intensity: 80, mode: 2, duration: 5 },
    { type: 'text', text: '呼吸渐促。' }
  ])
  // 等打字机消费(高 cps 应很快)
  await new Promise(r => setTimeout(r, 300))
  assertOk('指令在句子显示后执行', executed.length === 1 && executed[0] === 'vibration:80', `实际 ${executed.join(',')}`)
  assertOk('指令不可见(display 无 [[dev)', !display.includes('[[') && display.includes('她蜷起身子。') && display.includes('呼吸渐促。'))
  assertOk('自动会话已开始', autoStarted === 1)
  assertOk('全文 fullText 不含指令', tw.fullText === '她蜷起身子。呼吸渐促。', `实际 ${tw.fullText}`)

  // flush:流式期间已开始的会话收尾 + 剩余指令立即执行
  const tw2Executed: string[] = []
  let tw2Started = 0
  let tw2Ended = 0
  const tw2 = createTypewriter({
    cps: 1000,
    pauseScale: 0,
    onDisplay: () => {},
    onExecute: (cmd) => {
      tw2Executed.push(`${cmd.function}:${cmd.intensity}`)
      return true
    },
    onAutoStart: () => { tw2Started++ },
    onAutoEnd: () => { tw2Ended++ }
  })
  tw2.push([{ type: 'device', function: 'vibration', intensity: 40 }])
  await new Promise(r => setTimeout(r, 100))
  assertOk('流式指令先执行并进入会话', tw2Started === 1 && tw2Executed.includes('vibration:40'))
  tw2.push([{ type: 'text', text: 'x' }, { type: 'device', function: 'suction', intensity: 60 }])
  tw2.flush()
  await new Promise(r => setTimeout(r, 50))
  assertOk('flush 执行剩余指令', tw2Executed.includes('suction:60'))
  assertOk('flush 后自动会话收尾', tw2Ended === 1, `实际 ${tw2Ended}`)

  // 被拒指令不进入锁定(自动会话不开始)
  let autoStarted3 = 0
  const tw3 = createTypewriter({
    cps: 1000,
    pauseScale: 0,
    onDisplay: () => {},
    onExecute: () => false,
    onAutoStart: () => { autoStarted3++ },
    onAutoEnd: () => {}
  })
  tw3.push([{ type: 'device', function: 'vibration', intensity: 999 }])
  await new Promise(r => setTimeout(r, 200))
  assertOk('被拒指令不进入自动会话', autoStarted3 === 0)

  // wave/stop 指令路由到 onExecute(kind 区分)
  const kinds: string[] = []
  const tw4 = createTypewriter({
    cps: 1000,
    pauseScale: 0,
    onDisplay: () => {},
    onExecute: (cmd) => {
      kinds.push(cmd.kind)
      return true
    },
    onAutoStart: () => {},
    onAutoEnd: () => {}
  })
  tw4.push([
    { type: 'wave', function: 'vibration', pattern: 'sine', duration: 10 },
    { type: 'stop', function: 'vibration' }
  ])
  await new Promise(r => setTimeout(r, 200))
  assertOk('wave/stop 指令路由', kinds.includes('wave') && kinds.includes('stop'), `实际 ${kinds.join(',')}`)
}

console.log(`\n${failCount === 0 ? 'PASS' : 'FAIL'} · 通过 ${passCount} · 失败 ${failCount}`)
process.exit(failCount === 0 ? 0 : 1)
