// app/utils/narrStream.ts
// 叙事流指令解析器(增量状态机):从 SSE 文本流中识别 [[dev:...]] / [[pause:...]] 指令,
// 处理跨 chunk 边界;输出 token 队列供 typewriter 按序消费(文本限速显示、指令到句执行)。
// 容错:非法/未闭合指令静默丢弃(不显示、console 记录),不阻塞正文。

export type NarrToken
  = | { type: 'text', text: string }
    | { type: 'device', adapter?: string, function: string, intensity: number, mode?: number, duration?: number }
    | { type: 'wave', adapter?: string, function: string, pattern: string, duration?: number }
    | { type: 'stop', adapter?: string, function: string }
    | { type: 'pause', ms: number }

/** 解析 [[...]] 内部内容;非法返回 null(静默丢弃) */
function parseDirective(inner: string): NarrToken | null {
  const s = inner.trim()
  if (s.startsWith('pause:')) {
    const ms = Number(s.slice('pause:'.length).trim())
    if (Number.isFinite(ms) && ms >= 0 && ms <= 10000) return { type: 'pause', ms: Math.round(ms) }
    return null
  }
  if (s.startsWith('dev:')) {
    // [[dev:[插件id:]功能id:INTENSITY[:MODE[:DURATION]]]] — 首段非数字(功能强度)即视为插件 id 前缀(多设备路由)
    const parts = s.slice('dev:'.length).split(':').map(x => x.trim())
    let adapter: string | undefined
    let fn = parts[0]
    let intensity = Number(parts[1])
    if (parts.length >= 3 && !Number.isFinite(Number(parts[1]))) {
      adapter = parts[0]
      fn = parts[1]
      intensity = Number(parts[2])
    }
    if (!fn || !Number.isFinite(intensity)) return null
    const mode = parts[adapter ? 3 : 2] != null && parts[adapter ? 3 : 2] !== '' ? Number(parts[adapter ? 3 : 2]) : undefined
    const duration = parts[adapter ? 4 : 3] != null && parts[adapter ? 4 : 3] !== '' ? Number(parts[adapter ? 4 : 3]) : undefined
    if (mode !== undefined && !Number.isFinite(mode)) return null
    if (duration !== undefined && !Number.isFinite(duration)) return null
    return {
      type: 'device',
      ...(adapter ? { adapter } : {}),
      function: fn,
      intensity: Math.round(intensity),
      ...(mode !== undefined ? { mode: Math.round(mode) } : {}),
      ...(duration !== undefined ? { duration: Math.round(duration) } : {})
    }
  }
  if (s.startsWith('wave:')) {
    // [[wave:[插件id:]功能id:PATTERN[:DURATION]]] — 调教模式(可调强度的能力统一提供)
    const parts = s.slice('wave:'.length).split(':').map(x => x.trim())
    let adapter: string | undefined
    let fn = parts[0]
    let pattern = parts[1]
    const PATTERNS = ['sine', 'pulse', 'sawtooth', 'heartbeat', 'random', 'constant', 'auto']
    if (parts.length >= 3 && !PATTERNS.includes(parts[1] ?? '')) {
      adapter = parts[0]
      fn = parts[1]
      pattern = parts[2]
    }
    if (!fn || !pattern) return null
    const duration = parts[adapter ? 3 : 2] != null && parts[adapter ? 3 : 2] !== '' ? Number(parts[adapter ? 3 : 2]) : undefined
    if (duration !== undefined && !Number.isFinite(duration)) return null
    return {
      type: 'wave',
      ...(adapter ? { adapter } : {}),
      function: fn,
      pattern,
      ...(duration !== undefined ? { duration: Math.round(duration) } : {})
    }
  }
  if (s.startsWith('stop:')) {
    // [[stop:[插件id:]功能id]] — 停止该功能的调教并归零
    const parts = s.slice('stop:'.length).split(':').map(x => x.trim())
    const fn = parts[parts.length - 1]
    if (!fn) return null
    return {
      type: 'stop',
      ...(parts.length >= 2 ? { adapter: parts[0] } : {}),
      function: fn
    }
  }
  // 通用插件扩展语法(本期预留):[[act:PLUGIN:ACTION:JSON参数]] — 识别但暂不产出可执行 token
  if (s.startsWith('act:')) {
    if (typeof console !== 'undefined') console.warn('[narr] 通用插件指令 [[act:...]] 暂不支持,已忽略')
    return null
  }
  return null
}

export interface NarrParser {
  /** 喂入一段流式文本,返回新产出的 token(需交给 typewriter.push) */
  feed(text: string): NarrToken[]
  /** 流结束:flush 缓冲区;未闭合的非法指令静默丢弃,返回剩余 token */
  finish(): NarrToken[]
}

export function createNarrParser(): NarrParser {
  let buf = ''

  function drain(): NarrToken[] {
    const out: NarrToken[] = []
    for (;;) {
      const openIdx = buf.indexOf('[[')
      if (openIdx === -1) {
        if (buf) {
          out.push({ type: 'text', text: buf })
          buf = ''
        }
        return out
      }
      // [[ 前有正文 → text
      if (openIdx > 0) {
        out.push({ type: 'text', text: buf.slice(0, openIdx) })
        buf = buf.slice(openIdx)
        continue
      }
      // buf 以 [[ 开头:找闭合 ]]
      const closeIdx = buf.indexOf(']]', 2)
      if (closeIdx === -1) {
        // 未闭合:等待更多输入(流结束时由 finish 丢弃)
        return out
      }
      const inner = buf.slice(2, closeIdx)
      const directive = parseDirective(inner)
      if (directive) out.push(directive)
      else if (typeof console !== 'undefined') console.warn(`[narr] 非法指令已忽略:[[${inner}]]`)
      buf = buf.slice(closeIdx + 2)
    }
  }

  return {
    feed(text: string): NarrToken[] {
      buf += text
      return drain()
    },
    finish(): NarrToken[] {
      // 流结束:未闭合的 [[...]] 直接丢弃;其余作为正文
      const dangling = buf.indexOf('[[')
      if (dangling !== -1) {
        if (dangling > 0) {
          const tail = buf.slice(0, dangling)
          buf = ''
          return [{ type: 'text', text: tail }]
        }
        buf = ''
        return []
      }
      const out: NarrToken[] = []
      if (buf) out.push({ type: 'text', text: buf })
      buf = ''
      return out
    }
  }
}
