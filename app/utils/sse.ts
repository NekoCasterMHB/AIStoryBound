// app/utils/sse.ts
// SSE 事件块解析(event:/data: 行),供上传页/游戏页复用。Nuxt 会自动导入本文件导出。
export interface SseEventBlock {
  name: string
  payload: Record<string, unknown>
}

/** 解析一个以空行分隔的 SSE 事件块,返回 事件名 + payload;格式不符返回 null */
export function parseSseBlock(block: string): SseEventBlock | null {
  let name = ''
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!name || dataLines.length === 0) return null
  return { name, payload: JSON.parse(dataLines.join('\n')) }
}

/** 从 fetch 响应读取 SSE 流,按事件回调。block 解析抛错会向上传播。 */
export async function readSseStream(
  res: Response,
  onEvent: (ev: SseEventBlock) => void
): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (block.trim()) {
        const ev = parseSseBlock(block)
        if (ev) onEvent(ev)
      }
    }
  }
  const tail = buf.trim()
  if (tail) {
    const ev = parseSseBlock(tail)
    if (ev) onEvent(ev)
  }
}