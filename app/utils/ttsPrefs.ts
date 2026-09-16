// app/utils/ttsPrefs.ts
// 配音设置(本地 IndexedDB,prefs store,按作品/预置小说一个 scope 一行):
//  - 旁白音色 + 语速(全局默认,听书与游戏剧情朗读共用);
//  - 逐角色音色映射(角色名 → 音色;不设置 = 该角色不单独配音,对白回退旁白音色)。
// 与阅读进度同库(localDb.ts 的 prefs 表),仅浏览器端生效;不同步云端(用户本地偏好)。
import { db } from './localDb'
import { TTS_SPEED_DEFAULT, TTS_SPEED_MAX, TTS_SPEED_MIN } from '#shared/tts'

/** prefs 表行键前缀(同 Dexie PrefsRow,keyPath='key') */
const KEY_PREFIX = 'tts-voice:'

export interface WorkVoiceConfig {
  /** 旁白音色;空字符串 = 关闭旁白朗读(只播配置了音色的角色对白);缺省 = 默认晓晓 */
  narratorVoice: string
  /** 合成语速(0.5~2,缺省 1) */
  speed: number
  /** 打字机跟读:回合剧情显示时同步朗读(缺省 true;关闭后仅手动点朗读按钮播放) */
  autoSpeak: boolean
  /** 角色名 → 音色名;缺失/空 = 该角色不单独配音 */
  characters: Record<string, string>
}

export function defaultVoiceConfig(): WorkVoiceConfig {
  // 旁白默认关闭(空 = 不朗读叙述,只播配置了音色的角色对白);autoSpeak 默认开
  return { narratorVoice: '', speed: TTS_SPEED_DEFAULT, autoSpeak: true, characters: {} }
}

/** 读取一个 scope(作品 id 或 `preset:${预置小说id}`)的配音设置;无记录返回默认值 */
export async function loadVoiceConfig(scope: string): Promise<WorkVoiceConfig> {
  try {
    const row = await db.prefs.get(KEY_PREFIX + scope)
    const raw = row?.config as Partial<WorkVoiceConfig> | undefined
    if (!raw) return defaultVoiceConfig()
    const speed = typeof raw.speed === 'number' && Number.isFinite(raw.speed)
      ? Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, raw.speed))
      : TTS_SPEED_DEFAULT
    // narratorVoice:''是合法值(关闭旁白),仅 undefined/非法时按关闭处理
    const narratorVoice = typeof raw.narratorVoice === 'string' ? raw.narratorVoice : ''
    return {
      narratorVoice,
      speed,
      autoSpeak: raw.autoSpeak !== false,
      characters: raw.characters && typeof raw.characters === 'object' ? { ...raw.characters } : {}
    }
  } catch {
    return defaultVoiceConfig()
  }
}

/** 保存一个 scope 的配音设置(整行覆盖;IndexedDB 无部分更新) */
export async function saveVoiceConfig(scope: string, config: WorkVoiceConfig): Promise<void> {
  const clean: WorkVoiceConfig = {
    narratorVoice: typeof config.narratorVoice === 'string' ? config.narratorVoice : '',
    speed: Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, config.speed || TTS_SPEED_DEFAULT)),
    autoSpeak: config.autoSpeak !== false,
    characters: Object.fromEntries(
      Object.entries(config.characters ?? {}).filter(([, v]) => typeof v === 'string' && v)
    )
  }
  await db.prefs.put({ key: KEY_PREFIX + scope, config: clean })
}
