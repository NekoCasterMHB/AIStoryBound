// shared/tts.ts
// 语音合成(TTS)共享层:音色清单(与 Edge TTS Worker WebUI 实测过的音色名一致)、
// 参数边界、以及「旁白 + 引号对白」的多音色分段切分(游戏剧情朗读/听书共用)。
// 分段是纯函数:前端按段请求 /api/tts(服务端中转,见 server/api/tts.post.ts),逐段顺序播放。

export interface TtsVoiceOption {
  /** 微软音色名(直接透传给 Edge TTS) */
  value: string
  /** 展示名:「名字 · 语言」 */
  label: string
}

/**
 * 全部可选音色(值与 Edge TTS Worker WebUI 实测列表一致)。
 * 表项:[展示名, 音色值, 语言]。下拉文案只保留「名字 · 语言」。
 */
const VOICE_DEFS: Array<[name: string, value: string, lang: string]> = [
  // 普通话
  ['晓晓', 'zh-CN-XiaoxiaoNeural', '普通话'],
  ['云扬', 'zh-CN-YunyangNeural', '普通话'],
  ['晓伊', 'zh-CN-XiaoyiNeural', '普通话'],
  ['晓辰', 'zh-CN-XiaochenNeural', '普通话'],
  ['晓涵', 'zh-CN-XiaohanNeural', '普通话'],
  ['晓柔', 'zh-CN-XiaorouNeural', '普通话'],
  ['晓颜', 'zh-CN-XiaoyanNeural', '普通话'],
  ['晓秋', 'zh-CN-XiaoqiuNeural', '普通话'],
  ['晓甄', 'zh-CN-XiaozhenNeural', '普通话'],
  ['晓梦', 'zh-CN-XiaomengNeural', '普通话'],
  ['晓墨', 'zh-CN-XiaomoNeural', '普通话'],
  ['晓睿', 'zh-CN-XiaoruiNeural', '普通话'],
  ['云希', 'zh-CN-YunxiNeural', '普通话'],
  ['云健', 'zh-CN-YunjianNeural', '普通话'],
  ['云杰', 'zh-CN-YunjieNeural', '普通话'],
  ['云枫', 'zh-CN-YunfengNeural', '普通话'],
  ['云皓', 'zh-CN-YunhaoNeural', '普通话'],
  ['云泽', 'zh-CN-YunzeNeural', '普通话'],
  ['云野', 'zh-CN-YunyeNeural', '普通话'],
  ['晓双', 'zh-CN-XiaoshuangNeural', '普通话'],
  ['晓悠', 'zh-CN-XiaoyouNeural', '普通话'],
  ['云夏', 'zh-CN-YunxiaNeural', '普通话'],
  // 方言
  ['晓北', 'zh-CN-liaoning-XiaobeiNeural', '辽宁话'],
  ['云彪', 'zh-CN-liaoning-YunbiaoNeural', '辽宁话'],
  ['晓妮', 'zh-CN-shaanxi-XiaoniNeural', '陕西话'],
  ['云登', 'zh-CN-henan-YundengNeural', '河南话'],
  ['云翔', 'zh-CN-shandong-YunxiangNeural', '山东话'],
  ['云琦', 'zh-CN-guangxi-YunqiNeural', '广西话'],
  // 粤语 / 台湾
  ['曉佳', 'zh-HK-HiuGaaiNeural', '粤语'],
  ['曉曼', 'zh-HK-HiuMaanNeural', '粤语'],
  ['雲龍', 'zh-HK-WanLungNeural', '粤语'],
  ['曉臻', 'zh-TW-HsiaoChenNeural', '台湾国语'],
  ['曉雨', 'zh-TW-HsiaoYuNeural', '台湾国语'],
  ['雲哲', 'zh-TW-YunJheNeural', '台湾国语'],
  // 英语
  ['Jenny', 'en-US-JennyNeural', '英语'],
  ['Aria', 'en-US-AriaNeural', '英语'],
  ['Guy', 'en-US-GuyNeural', '英语'],
  ['Christopher', 'en-US-ChristopherNeural', '英语']
]

export const TTS_VOICES: TtsVoiceOption[] = VOICE_DEFS.map(([name, value, lang]) => ({
  value,
  label: `${name} · ${lang}`
}))

/** 默认旁白音色(晓晓) */
export const TTS_DEFAULT_NARRATOR_VOICE = 'zh-CN-XiaoxiaoNeural'

/** 单次请求文本长度上限(服务端钳制;Edge TTS Worker 实际可到 ~12 万) */
export const TTS_MAX_INPUT_CHARS = 50_000

/** 语速边界(UI 滑条范围;Edge TTS 底层支持 0.25~2) */
export const TTS_SPEED_MIN = 0.5
export const TTS_SPEED_MAX = 2
export const TTS_SPEED_DEFAULT = 1

/** 音色名白名单校验(防把 /api/tts 当任意参数代理用) */
export function isTtsVoice(v: unknown): v is string {
  return typeof v === 'string' && TTS_VOICES.some(o => o.value === v)
}

/** 按音色名取展示名(未知音色原样返回) */
export function ttsVoiceLabel(v: string): string {
  return TTS_VOICES.find(o => o.value === v)?.label ?? v
}

/**
 * 中文旁白基准语速(字符/秒,含标点自然停顿):
 * 实测 Edge TTS 默认语速 ≈4.8~4.9 字/秒(140 字 ≈28.4s、27 字 ≈5.8s),取 4.8 对齐实测。
 */
export const TTS_BASE_CHARS_PER_SECOND = 4.8

/** 估算合成音频时长(秒):字符数 ÷(基准语速 × 语速参数);语速越快时长越短、计费越少 */
export function estimateTtsSeconds(text: string, speed = 1): number {
  const chars = text.trim().length
  if (chars <= 0) return 0
  const sp = Math.min(2, Math.max(0.25, speed))
  return Math.ceil((chars / (TTS_BASE_CHARS_PER_SECOND * sp)) * 10) / 10
}

/** 计费 token:**1 秒音频 = 10 token**(向上取整;单次请求至少 1)。server/api/tts.post.ts 与前端统计同口径 */
export const TTS_TOKENS_PER_SECOND = 10

/** 计费 token = 音频秒数 × TTS_TOKENS_PER_SECOND(向上取整;单次请求至少 1)。server/api/tts.post.ts 与前端统计同口径 */
export function estimateTtsTokens(text: string, speed = 1): number {
  return Math.max(1, Math.ceil(estimateTtsSeconds(text, speed) * TTS_TOKENS_PER_SECOND))
}

/** 一个待合成的语音片段 */
export interface SpeechSegment {
  text: string
  /** 该片段使用的音色 */
  voice: string
}

export interface BuildSpeechOptions {
  /**
   * 旁白音色。传空字符串 = 关闭旁白朗读:叙述段与「无单独音色角色」的台词整段跳过不发声,
   * 只保留配置了音色的角色对白(纯有声剧模式)。
   */
  narratorVoice: string
  /** 可选说话角色名(按作品人物卡给出;名字越长越优先匹配) */
  speakerNames?: string[]
  /** 角色名 → 音色;返回 undefined 表示该角色不单独配音(对白回退旁白音色;旁白关闭时跳过) */
  voiceOf?: (name: string) => string | undefined
}

/** 归一化用于名字匹配(去空白;与游戏引擎的 normName 同口径) */
function normName(s: string): string {
  return s.replace(/\s+/g, '').trim()
}

/** 引号对白(中英弯引号 + 直角引号;上限 800 字防未闭合引号吞全章) */
const QUOTE_RE = /[“][^”]{0,800}[”]|「[^」]{0,800}」|『[^』]{0,800}』/g

/**
 * 把叙述文本切成多音色片段:
 *  - 引号内为对白,按「引号前的旁白尾句中出现的角色名」归属说话人;
 *    归属失败沿用上一个说话角色(连续对白),再失败回退旁白音色;
 *  - voiceOf 返回 undefined 的角色 = 不单独配音,其台词由旁白音色朗读;
 *  - 相邻同音色片段合并,超长片段按句读切开(单段 ≤1100 字,首段更快返回)。
 */
export function buildSpeechSegments(text: string, opts: BuildSpeechOptions): SpeechSegment[] {
  const names = (opts.speakerNames ?? [])
    .map(n => ({ raw: n, norm: normName(n) }))
    .filter(n => n.norm.length > 0)
    .sort((a, b) => b.norm.length - a.norm.length)
  const narratorOff = !opts.narratorVoice
  const raw: SpeechSegment[] = []
  let lastSpeaker: string | null = null
  let cursor = 0
  for (const m of text.match(QUOTE_RE) ?? []) {
    const start = text.indexOf(m, cursor)
    if (start < 0) continue
    const narration = text.slice(cursor, start)
    if (narration.trim() && !narratorOff) raw.push({ text: narration, voice: opts.narratorVoice })
    // 归属说话角色:在引号前的旁白尾段(末 60 字)找角色名
    const gap = normName(narration.slice(-60))
    let speaker: string | null = null
    if (opts.voiceOf) {
      // 取「离引号最近出现」的角色名(引号前刚说完「XX道:」的才是说话人;
      // 名单顺序不可靠——旁白里常先提到别的角色,如「青璃推门而入…掌柜压低了声音:」)
      let best: { name: string, pos: number } | null = null
      for (const n of names) {
        const pos = gap.lastIndexOf(n.norm)
        if (pos >= 0 && (!best || pos > best.pos)) best = { name: n.raw, pos }
      }
      speaker = best?.name ?? lastSpeaker
    }
    if (speaker) lastSpeaker = speaker
    const voice = (speaker && opts.voiceOf?.(speaker)) || opts.narratorVoice
    if (voice) raw.push({ text: m, voice })
    cursor = start + m.length
  }
  if (text.slice(cursor).trim() && !narratorOff) raw.push({ text: text.slice(cursor), voice: opts.narratorVoice })

  // 相邻同音色合并 → 超长段按句读切分
  const merged: SpeechSegment[] = []
  for (const seg of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.voice === seg.voice) prev.text += seg.text
    else merged.push({ ...seg })
  }
  return merged.flatMap(seg => splitLongSegment(seg.text, seg.voice, 1100))
}

/** 按句读把超长片段切开:攒满 max 后在下一个句读符处落段(避免每句一切产生海量碎段);无句读符则到 2×max 硬切 */
function splitLongSegment(text: string, voice: string, max: number): SpeechSegment[] {
  if (text.length <= max) return [{ text, voice }]
  const parts: SpeechSegment[] = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (buf.length >= max * 2 || (buf.length >= max && /[。!?!?…\n]/.test(ch))) {
      if (buf.trim()) parts.push({ text: buf, voice })
      buf = ''
    }
  }
  if (buf.trim()) parts.push({ text: buf, voice })
  return parts
}
