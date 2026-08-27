// app/toy/runtime/worker.ts
// Tier 2 玩家适配器沙箱:适配器代码(纯函数 buildFrames/buildInitFrames/buildStopFrames)
// 在 Web Worker 里执行——拿不到蓝牙/网络/DOM,主线程只与它交换结构化数据。
// 约定:玩家代码在 Worker 全局作用域定义 self.buildFrames 等函数(见 sdk-template)。
import type { DeviceEvent, ToyAdapter, ToyAdapterManifest } from '#shared/toy'

interface WorkerRequest {
  id: number
  type: 'init' | 'stop' | 'command'
  command?: DeviceEvent
  lastState?: Record<string, { mode?: number }>
}
interface WorkerResponse {
  id: number
  ok: boolean
  frames?: number[][]
  error?: string
}

/** 包在玩家代码之后的 Worker 主循环:调用全局 buildFrames 等并回传帧数组 */
const WORKER_WRAPPER = `
self.onmessage = (e) => {
  const req = e.data
  try {
    let frames = []
    if (req.type === 'init') {
      frames = typeof self.buildInitFrames === 'function' ? self.buildInitFrames() : []
    } else if (req.type === 'stop') {
      frames = typeof self.buildStopFrames === 'function' ? self.buildStopFrames(req.lastState || {}) : []
    } else {
      if (typeof self.buildFrames !== 'function') throw new Error('适配器缺少 buildFrames 函数')
      frames = self.buildFrames(req.command) || []
    }
    self.postMessage({
      id: req.id,
      ok: true,
      frames: frames.map(f => Array.from(f instanceof Uint8Array ? f : new Uint8Array(f)))
    })
  } catch (err) {
    self.postMessage({ id: req.id, ok: false, error: String((err && err.stack) || err) })
  }
}
`

const CALL_TIMEOUT_MS = 2000

function toUint8Array(frames: number[][]): Uint8Array[] {
  return frames.map(f => Uint8Array.from(f))
}

/**
 * 把一个 Tier 2 适配器(manifest + 代码)包装成 ToyAdapter:
 * 每次调用在独立 Worker 中执行代码并返回帧;代码异常/超时/非 Uint8Array 输出都会报错。
 */
export function createSandboxedAdapter(manifest: ToyAdapterManifest, code: string): ToyAdapter {
  if (typeof Worker === 'undefined') throw new Error('Tier 2 代码适配器仅浏览器支持')

  let seq = 0

  async function call(req: Omit<WorkerRequest, 'id'>): Promise<Uint8Array[]> {
    const blob = new Blob([code, '\n', WORKER_WRAPPER], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const worker = new Worker(url)
    try {
      const result = await new Promise<WorkerResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('适配器执行超时(2s)')), CALL_TIMEOUT_MS)
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          clearTimeout(timer)
          resolve(e.data)
        }
        worker.onerror = (e) => {
          clearTimeout(timer)
          reject(new Error(`适配器代码错误:${e.message}`))
        }
        worker.postMessage({ ...req, id: ++seq })
      })
      if (!result.ok) throw new Error(result.error ?? '适配器执行失败')
      return toUint8Array(result.frames ?? [])
    } finally {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  }

  return {
    manifest,
    async buildFrames(command: DeviceEvent): Promise<Uint8Array[]> {
      return call({ type: 'command', command })
    },
    async buildInitFrames(): Promise<Uint8Array[]> {
      return call({ type: 'init' })
    },
    async buildStopFrames(lastState: Record<string, { mode?: number }>): Promise<Uint8Array[]> {
      return call({ type: 'stop', lastState })
    }
  }
}
