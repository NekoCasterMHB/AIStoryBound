// TTS 说话人归属测试:冒号强信号(「角色名+引导词:」紧邻引号)、连续对白兜底、旁白关闭跳过
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSpeechSegments } from './tts'

const VOICES: Record<string, string> = {
  青璃: 'v-qingli',
  小美: 'v-xiaomei',
  林凡: 'v-linfan',
  掌柜: 'v-zhanggui'
}
const voiceOf = (n: string) => VOICES[n]

test('buildSpeechSegments:冒号紧邻的角色名优先归属(引导词带修饰也命中)', () => {
  const segs = buildSpeechSegments('青璃推门而入,环视一周。掌柜压低了声音:「客官,里面请。」', {
    narratorVoice: 'v-narr',
    speakerNames: Object.keys(VOICES),
    voiceOf
  })
  const quote = segs.find(s => s.text.includes('客官'))
  assert.equal(quote?.voice, 'v-zhanggui')
})

test('buildSpeechSegments:长名优先于短名(名含同名前缀不误配)', () => {
  // 「小美」是「王小美」的尾部:长名应优先命中
  const segs = buildSpeechSegments('王小美低声道:「走吧。」', {
    narratorVoice: 'v-narr',
    speakerNames: ['小美', '王小美'],
    voiceOf: n => (n === '王小美' ? 'v-wang' : 'v-xiaomei')
  })
  const quote = segs.find(s => s.text.includes('走吧'))
  assert.equal(quote?.voice, 'v-wang')
})

test('buildSpeechSegments:无冒号回退「离引号最近的角色名」,再回退上一说话人', () => {
  // 无冒号:旁白尾段离引号最近的是 小美
  const a = buildSpeechSegments('酒过三巡,席间只剩小美。「你到底想说什么?」', {
    narratorVoice: 'v-narr', speakerNames: Object.keys(VOICES), voiceOf
  })
  assert.equal(a.find(s => s.text.includes('想说什么'))?.voice, 'v-xiaomei')
  // 连续对白(引号间无旁白):沿用上一说话人
  const b = buildSpeechSegments('小美低声道:「第一句。」「第二句。」', {
    narratorVoice: 'v-narr', speakerNames: Object.keys(VOICES), voiceOf
  })
  const q1 = b.find(s => s.text.includes('第一句'))
  const q2 = b.find(s => s.text.includes('第二句'))
  assert.equal(q1?.voice, 'v-xiaomei')
  assert.equal(q2?.voice, 'v-xiaomei')
})

test('buildSpeechSegments:旁白关闭时——未配音角色的对白跳过,配了音的照播', () => {
  const segs = buildSpeechSegments('青璃低声道:「跟我来。」林凡耸耸肩:「随你。」', {
    narratorVoice: '',
    speakerNames: Object.keys(VOICES),
    voiceOf: n => (n === '青璃' ? 'v-qingli' : undefined)
  })
  // 青璃有独立音色:保留;林凡未配置且回退旁白音色为空:整段跳过
  assert.deepEqual(segs, [{ text: '「跟我来。」', voice: 'v-qingli' }])
})

test('buildSpeechSegments:叙述与对白按音色切块,相邻同音色合并', () => {
  const segs = buildSpeechSegments('夜里落了雪。青璃低声道:「走吧。」两人踏雪而行。', {
    narratorVoice: 'v-narr', speakerNames: Object.keys(VOICES), voiceOf
  })
  // 引导语「青璃低声道:」随其前叙述块由旁白音色朗读(既有行为)
  assert.deepEqual(segs.map(s => [s.voice, s.text]), [
    ['v-narr', '夜里落了雪。青璃低声道:'],
    ['v-qingli', '「走吧。」'],
    ['v-narr', '两人踏雪而行。']
  ])
})
