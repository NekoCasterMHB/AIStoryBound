// app/utils/scenePrefs.ts
// 游玩偏好场景(本地偏好):用户自定的「偏好场景」与「避免出现的场景」,
// 注入叙事提示词,优先级低于系统规则(与系统规则/人物卡冲突时以系统为准)。
const KEY = 'game-scene-prefs-v1'

export interface ScenePrefs {
  /** 偏好场景:叙事可适度增加相关内容 */
  prefer?: string
  /** 避免场景:尽量不出现的内容 */
  avoid?: string
}

export function loadScenePrefs(): ScenePrefs {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as ScenePrefs
      return { prefer: typeof v.prefer === 'string' ? v.prefer : undefined, avoid: typeof v.avoid === 'string' ? v.avoid : undefined }
    }
  } catch {
    // 数据损坏按空处理
  }
  return {}
}

export function saveScenePrefs(v: ScenePrefs): void {
  if (typeof localStorage === 'undefined') return
  const clean: ScenePrefs = {}
  if (v.prefer?.trim()) clean.prefer = v.prefer.trim()
  if (v.avoid?.trim()) clean.avoid = v.avoid.trim()
  if (Object.keys(clean).length) localStorage.setItem(KEY, JSON.stringify(clean))
  else localStorage.removeItem(KEY)
}
