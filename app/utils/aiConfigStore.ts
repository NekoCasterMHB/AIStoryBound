// app/utils/aiConfigStore.ts
// 自建 AI 配置本地加密存储(模式 A):随机 AES-256-GCM 密钥、extractable=false,
// CryptoKey 对象存 IndexedDB(材料受操作系统钥匙串/DPAPI 包裹);配置整体加密落 IDB。
// 服务端不保存任何配置——调用时由 aiRelay 将活跃配置随请求体临时带上,仅本次请求内存使用。
import type { AiApiFormat } from '#shared/ai-config'

export interface LocalAiConfig {
  id: string
  name: string
  format: AiApiFormat
  baseUrl: string
  apiKey: string
  model: string
  thinking: boolean
  /** 是否为当前启用的配置(至多一个) */
  active?: boolean
}

export interface AiConfigState {
  enabled: boolean
  configs: LocalAiConfig[]
}

const DB_NAME = 'aistorybound'
const STORE_NAME = 'kv'
const KEY_RECORD = 'ai-master-key'
const DATA_RECORD = 'ai-configs'
/** 认证附加数据:绑定密文用途,防止密文被搬到别的场景 */
const AAD = new TextEncoder().encode('aistorybound-ai-configs-v1')

interface Envelope {
  v: 1
  iv: string
  ct: string
}

let dbPromise: Promise<IDBDatabase> | null = null
let keyPromise: Promise<CryptoKey> | null = null
let sessionKey: CryptoKey | null = null

let state: AiConfigState = { enabled: false, configs: [] }
let loaded = false
let loadPromise: Promise<void> | null = null
/** 保存自增:防止"载入中的旧数据"覆盖"已保存的新数据" */
let revision = 0

// ---- IndexedDB 基础 ----

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前环境不支持 IndexedDB'))
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
    })
  }
  return dbPromise
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(db => new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'))
  }))
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'))
  }))
}

// ---- 密钥与加解密 ----

function bufToB64(buf: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function b64ToBuf(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 取回或首次生成主密钥;extractable=false,任何代码都无法导出原始字节 */
async function getOrCreateMasterKey(): Promise<CryptoKey> {
  if (sessionKey) return sessionKey
  if (keyPromise) return keyPromise
  keyPromise = (async () => {
    let key = await idbGet<CryptoKey>(KEY_RECORD)
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await idbPut(KEY_RECORD, key)
    }
    sessionKey = key
    return key
  })()
  return keyPromise
}

async function encryptJson(obj: unknown): Promise<Envelope> {
  const key = await getOrCreateMasterKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(obj))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, data)
  return { v: 1, iv: bufToB64(iv), ct: bufToB64(new Uint8Array(ct)) }
}

async function decryptJson(env: Envelope): Promise<unknown> {
  const key = await getOrCreateMasterKey()
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(env.iv), additionalData: AAD }, key, b64ToBuf(env.ct))
  return JSON.parse(new TextDecoder().decode(pt))
}

// ---- 状态读写 ----

/** 确保内存态已从 IDB 载入(幂等;解密失败视作无配置) */
export function ensureAiConfigLoaded(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loadPromise) return loadPromise
  const revAtStart = revision
  loadPromise = (async () => {
    try {
      const env = await idbGet<Envelope>(DATA_RECORD)
      if (env && env.v === 1 && revAtStart === revision) {
        state = (await decryptJson(env)) as AiConfigState
      }
    } catch {
      if (revAtStart === revision) state = { enabled: false, configs: [] }
    } finally {
      if (revAtStart === revision) loaded = true
    }
  })()
  return loadPromise
}

export function getAiConfigStateSync(): AiConfigState {
  return state
}

/** 整体保存(加密落 IDB 并更新内存态) */
export async function saveAiConfigState(next: AiConfigState): Promise<void> {
  revision += 1
  state = next
  loaded = true
  await idbPut(DATA_RECORD, await encryptJson(next))
}

/** 当前会话要随请求携带的自建配置(仅当用户启用自建时返回;未加载则先载入) */
export async function getActiveRelayConfig(): Promise<{
  format: AiApiFormat
  baseUrl: string
  apiKey: string
  model: string
} | null> {
  await ensureAiConfigLoaded()
  if (!state.enabled) return null
  const active = state.configs.find(c => c.active) ?? state.configs[0]
  if (!active?.baseUrl || !active?.apiKey) return null
  return {
    format: active.format,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model || 'default'
  }
}