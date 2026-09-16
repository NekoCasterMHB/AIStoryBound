// app/utils/ttsPlayer.ts
// 语音播放器单例(游戏剧情朗读/阅读页听书共用):
//  - playTtsSource(片段列表)→ 逐段请求 /api/tts(登录中转)→ Blob 对象 URL 顺序播放;
//  - 相邻段流水线:当前段播放时预取下一段,段间尽量无缝;
//  - Blob 缓存(音色|语速|文本 → URL,上限 100 段):重复朗读/回放零请求;
//  - stop/pause/resume;currentSource 供 UI 标记「正在朗读哪条消息/哪一章」。
// SSR 安全:audio 元素懒创建;非浏览器环境 playTtsSource 为空操作。
import { ref } from 'vue'
import type { SpeechSegment } from '#shared/tts'

export type TtsPlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface TtsSource {
  /** 来源标识(游戏消息 id / 阅读器章节);再次播放同来源视为切换 */
  id: string
  /** 展示名(播放指示用) */
  label: string
  segments: SpeechSegment[]
}

export interface TtsPlayOptions {
  /** 合成语速(透传 /api/tts;缓存键的一部分) */
  speed?: number
  /** 全部片段播完(未被打断)后回调;阅读页用它自动连播下一章 */
  onFinished?: () => void
}

// ---- 单例响应式状态(模块级;游戏页/阅读页共享同一播放器,互斥播放) ----
const state = ref<TtsPlayState>('idle')
const currentSource = ref<TtsSource | null>(null)
const currentIndex = ref(0)
const totalSegments = ref(0)

let audio: HTMLAudioElement | null = null
let playToken = 0
let pausedByUser = false
/** 当前段播完(ended/出错/被打断)时落定播放循环的 await */
let segmentDone: (() => void) | null = null

/** Blob 对象 URL 缓存(音色|语速|文本 → objectURL);FIFO 淘汰时 revoke */
const blobCache = new Map<string, string>()
const BLOB_CACHE_MAX = 100

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio()
    audio.addEventListener('ended', () => segmentDone?.())
    audio.addEventListener('error', () => segmentDone?.())
  }
  return audio
}

async function fetchSegmentUrl(text: string, voice: string, speed: number): Promise<string> {
  const key = `${voice}|${speed}|${text}`
  const hit = blobCache.get(key)
  if (hit) {
    blobCache.delete(key)
    blobCache.set(key, hit) // LRU 触碰
    return hit
  }
  const res = await $fetch.raw('/api/tts', {
    method: 'POST',
    body: { input: text, voice, speed },
    responseType: 'blob'
  })
  const url = URL.createObjectURL(res._data as unknown as Blob)
  blobCache.set(key, url)
  if (blobCache.size > BLOB_CACHE_MAX) {
    const oldest = blobCache.keys().next().value
    if (oldest !== undefined) {
      const oldUrl = blobCache.get(oldest)
      if (oldUrl) URL.revokeObjectURL(oldUrl)
      blobCache.delete(oldest)
    }
  }
  return url
}

/** 播放一个片段列表(顺序;再次调用会打断上一个来源)。抛错 = 某段合成失败(已停止) */
export async function playTtsSource(source: TtsSource, opts: TtsPlayOptions = {}): Promise<void> {
  if (typeof window === 'undefined' || source.segments.length === 0) return
  const speed = opts.speed ?? 1
  const token = ++playToken
  pausedByUser = false
  currentSource.value = source
  totalSegments.value = source.segments.length
  currentIndex.value = 0
  state.value = 'loading'

  try {
    // 流水线:播第 i 段的同时预取第 i+1 段
    let nextUrl: Promise<string> | null = fetchSegmentUrl(
      source.segments[0]!.text, source.segments[0]!.voice, speed
    )
    for (let i = 0; i < source.segments.length; i++) {
      if (token !== playToken) return
      currentIndex.value = i
      const url: string = await nextUrl!
      if (token !== playToken) return
      nextUrl = i + 1 < source.segments.length
        ? fetchSegmentUrl(source.segments[i + 1]!.text, source.segments[i + 1]!.voice, speed)
        : null
      // 暂停落在段间(上段播完、下段已就绪):挂起等恢复
      if (pausedByUser) {
        state.value = 'paused'
        await waitWhileResumed()
        if (token !== playToken) return
      }
      await playSegment(url)
    }
    if (token !== playToken) return
    stopTts()
    opts.onFinished?.()
  } catch (e) {
    if (token !== playToken) return
    stopTts() // 复位(迷你条消失),错误交调用方 toast
    throw e
  }
}

/** 播放单个音频 URL,resolve 于播完/出错/被打断(stop) */
function playSegment(url: string): Promise<void> {
  return new Promise((resolve) => {
    const a = ensureAudio()
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      segmentDone = null
      resolve()
    }
    segmentDone = done
    a.src = url
    void a.play()
      .then(() => {
        // play() 成功后仍可能已被 stop 打断(token 变化时 done 已走,这里不会再置 playing)
        if (!settled && !pausedByUser) state.value = 'playing'
      })
      .catch(() => done())
  })
}

function waitWhileResumed(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (pausedByUser ? setTimeout(check, 120) : resolve())
    check()
  })
}

/** 暂停(播放中暂停当前段;加载中暂停则下一段就绪后不自动续播) */
export function pauseTts(): void {
  if (state.value === 'playing') {
    pausedByUser = true
    ensureAudio().pause()
    state.value = 'paused'
  } else if (state.value === 'loading') {
    pausedByUser = true
  }
}

/** 恢复播放 */
export function resumeTts(): void {
  if (state.value !== 'paused') return
  pausedByUser = false
  ensureAudio().play().catch(() => { /* 自动恢复失败:保留暂停态,用户可再试 */ })
  state.value = 'playing'
}

/** 停止并清空来源(幂等) */
export function stopTts(): void {
  playToken++
  pausedByUser = false
  if (audio) audio.pause()
  segmentDone?.() // 让挂起的播放循环落定退出
  state.value = 'idle'
  currentSource.value = null
  currentIndex.value = 0
  totalSegments.value = 0
}

/** 已发起预取的键(去重:跟读门每 tick 都可能请求同一段预取,避免并发重复请求) */
const prefetchedKeys = new Set<string>()

/** 预取一段音频进缓存(不播放);打字机跟读在文字显示期间预取,播到该段时零等待 */
export function prefetchTts(text: string, voice: string, speed = 1): void {
  if (typeof window === 'undefined' || !text.trim()) return
  const key = `${voice}|${speed}|${text}`
  if (prefetchedKeys.has(key)) return
  prefetchedKeys.add(key)
  void fetchSegmentUrl(text, voice, speed).catch(() => {
    /* 预取失败静默:真播放时会再试 */
  })
}

/** 播放器单例(页面统一从这里取状态与方法) */
export const ttsPlayer = {
  state,
  currentSource,
  currentIndex,
  totalSegments,
  playTtsSource,
  pauseTts,
  resumeTts,
  stopTts,
  prefetchTts
}
