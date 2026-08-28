// app/toy/builtin/sosexy/plugin.ts
// 啵啵贝(FUNF SOSEXY)内置插件:平台强制格式 PluginDescriptor 实例。
// 协议细节在 protocol.json(uuid/帧模板/通道/初始化);capabilities 显式声明
// (含每能力强度上限 0-100,AI 可知可控范围);ui 缺省由平台按 capabilities 生成默认布局。
import type { PluginDescriptor } from '#shared/plugin'
import type { ToyProtocolConfig } from '#shared/toy'
import protocol from './protocol.json'

export const SOSEXY_PLUGIN: PluginDescriptor = {
  id: 'sosexy',
  name: '啵啵贝 (FUNF SOSEXY)',
  version: '1.0.0',
  icon: '🫧',
  description: '让 AI 在剧情中自主操作啵啵贝智能玩具(吮吸/震动/微电流),指令与台词同步;可模拟测试或真机蓝牙直连。',
  runtime: {
    type: 'toy-protocol',
    scanNames: ['SOSEXY'],
    protocol: {
      ...(protocol as unknown as ToyProtocolConfig),
      battery: { supported: true }
    }
  },
  capabilities: [
    {
      id: 'suction',
      name: '吮吸',
      description: '吮吸强度控制,用于挑逗、前戏、高潮等情节。intensity 越大刺激越强;mode 为档位;duration 为持续秒数(到时自动停止)。',
      params: [
        { key: 'intensity', type: 'int', min: 0, max: 100, description: '强度 0-100(0=停止)' },
        { key: 'mode', type: 'enum', values: [1, 2, 3, 4].map(v => ({ value: v, label: `档位 ${v}` })), description: '模式档位 1-4' },
        { key: 'duration', type: 'int', min: 0, max: 3600, description: '持续秒数(到时自动停止;0=不限)' }
      ]
    },
    {
      id: 'vibration',
      name: '震动',
      description: '震动强度控制,用于节奏性身体互动情节。intensity 越大震动越强;mode 为档位;duration 为持续秒数(到时自动停止)。',
      params: [
        { key: 'intensity', type: 'int', min: 0, max: 100, description: '强度 0-100(0=停止)' },
        { key: 'mode', type: 'enum', values: [1, 2, 3, 4].map(v => ({ value: v, label: `档位 ${v}` })), description: '模式档位 1-4' },
        { key: 'duration', type: 'int', min: 0, max: 3600, description: '持续秒数(到时自动停止;0=不限)' }
      ]
    },
    {
      id: 'electric',
      name: '微电流',
      description: '微电流强度控制,用于电击/刺痛类情节。intensity 越大电流越强;mode 为档位;duration 为持续秒数(到时自动停止)。',
      params: [
        { key: 'intensity', type: 'int', min: 0, max: 100, description: '强度 0-100(0=停止)' },
        { key: 'mode', type: 'enum', values: [1, 2, 3, 4].map(v => ({ value: v, label: `档位 ${v}` })), description: '模式档位 1-4' },
        { key: 'duration', type: 'int', min: 0, max: 3600, description: '持续秒数(到时自动停止;0=不限)' }
      ]
    }
  ]
}
