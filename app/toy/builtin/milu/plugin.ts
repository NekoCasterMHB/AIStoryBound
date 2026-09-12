// app/toy/builtin/milu/plugin.ts
// 迷路(Kisstoy Lost)内置插件:平台强制格式 PluginDescriptor 实例,分吮吸版/入体版两款。
// 同一 galaku 协议(见 frames.ts),BLE 广播名区分硬件:QCSW = 吮吸版,QCPW = 入体版
// (QCVW 震动版同协议,如需支持追加 scanNames 即可)。协议含链式加密,runtime 走 toy-code,
// 执行代码为内置 frames.ts(不经玩家沙箱,注册见 adapter-loader)。
// capabilities 显式声明(含每能力强度上限 0-100);ui 缺省由平台按 capabilities 生成默认布局。
import type { PluginDescriptor } from '#shared/plugin'

/** galaku 通用 GATT(服务 0x1000 / 写 0x1001 / 通知 0x1002;写不带响应,buttplug 测试同款) */
const MILU_GATT = {
  serviceUuid: '00001000-0000-1000-8000-00805f9b34fb',
  writeUuid: '00001001-0000-1000-8000-00805f9b34fb',
  notifyUuid: '00001002-0000-1000-8000-00805f9b34fb',
  writeWithResponse: false
} as const

/** 电量声明:galaku 电量需「写查询帧 + 通知回读」握手,平台电量读法(纯 readValue)不兼容,声明不支持 */
const MILU_BATTERY = { supported: false } as const

const DURATION_PARAM = {
  key: 'duration',
  type: 'int',
  min: 0,
  max: 3600,
  description: '持续秒数(到时自动停止;0=不限)'
} as const

function intensityParam(description: string) {
  return { key: 'intensity', type: 'int' as const, min: 0, max: 100, description }
}

export const MILU_SUCKING_PLUGIN: PluginDescriptor = {
  id: 'milu-sucking',
  name: '迷路吮吸版 (Kisstoy Lost)',
  version: '1.0.0',
  icon: '🧭',
  description: '让 AI 在剧情中自主操作 Kisstoy 迷路吮吸版(QCSW)智能玩具(吮吸/震动双通道),指令与台词同步;可模拟测试或真机蓝牙直连。',
  runtime: {
    type: 'toy-code',
    scanNames: ['QCSW'],
    gatt: { ...MILU_GATT },
    battery: { ...MILU_BATTERY }
  },
  capabilities: [
    {
      id: 'suction',
      name: '吮吸',
      description: '吮吸强度控制(通道 0),用于挑逗、前戏、高潮等情节。intensity 越大吸力越强;duration 为持续秒数(到时自动停止)。',
      params: [
        intensityParam('强度 0-100(0=停止)'),
        { ...DURATION_PARAM }
      ]
    },
    {
      id: 'vibration',
      name: '震动',
      description: '震动强度控制(通道 1),用于节奏性身体互动情节。intensity 越大震动越强;duration 为持续秒数(到时自动停止)。',
      params: [
        intensityParam('强度 0-100(0=停止)'),
        { ...DURATION_PARAM }
      ]
    }
  ]
}

export const MILU_INSERTABLE_PLUGIN: PluginDescriptor = {
  id: 'milu-insertable',
  name: '迷路入体版 (Kisstoy Lost)',
  version: '1.0.1',
  icon: '🧭',
  description: '让 AI 在剧情中自主操作 Kisstoy 迷路入体版(QCPW)智能玩具(震动/吮吸双通道),指令与台词同步;可模拟测试或真机蓝牙直连。',
  runtime: {
    type: 'toy-code',
    scanNames: ['QCPW'],
    gatt: { ...MILU_GATT },
    battery: { ...MILU_BATTERY }
  },
  capabilities: [
    {
      id: 'vibration-a',
      name: '主震动',
      description: '主马达震动强度控制(通道 0),用于入体主线情节。intensity 越大震动越强;duration 为持续秒数(到时自动停止)。',
      params: [
        intensityParam('强度 0-100(0=停止)'),
        { ...DURATION_PARAM }
      ]
    },
    {
      id: 'suction',
      name: '吮吸',
      description: '吮吸强度控制(通道 1),用于挑逗、前戏、高潮等情节。intensity 越大吸力越强;duration 为持续秒数(到时自动停止)。',
      params: [
        intensityParam('强度 0-100(0=停止)'),
        { ...DURATION_PARAM }
      ]
    }
  ]
}
