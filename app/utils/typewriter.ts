// app/utils/typewriter.ts
// 流式打字机:消费 narrStream 的 token 队列——
// 文本按字符/秒限速显示 + 标点微停顿;device/wave/stop 指令 token 到达(该句显示完)即执行,
// 指令对玩家不可见;pause token 到达暂停抽取;点击 flush 立即显示全文并顺序执行剩余指令。
// 纯逻辑无 Vue 依赖(Node 可测);显示变化通过 onDisplay 回调通知。
// 自动控制会话:第一条指令执行成功时 onAutoStart,自然播完/flush 收尾后 onAutoEnd(指令被拒不锁定)。
import type { NarrToken } from './narrStream'

/** 可执行指令:dev 单次事件 / wave 调教模式 / stop 停止调教 */
export type TypewriterCmd
  = | { kind: 'dev', function: string, intensity: number, mode?: number, duration?: number }
    | { kind: 'wave', function: string, pattern: string, duration?: number }
    | { kind: 'stop', function: string }

export interface TypewriterOptions {
  /** 显示速率(字符/秒) */
  cps: number
  /** 标点停顿缩放(慢 ×1.5 / 标准 ×1.0 / 快 ×0.6) */
  pauseScale?: number
  /** 显示文本变化回调 */
  onDisplay: (text: string) => void
  /** 指令执行(返回是否成功;失败仅提示,不阻塞正文) */
  onExecute?: (cmd: TypewriterCmd) => Promise<boolean> | boolean
  /** 自动控制会话开始(第一条指令执行成功时) */
  onAutoStart?: () => void
  /** 自动控制会话结束(自然播完/flush 收尾后) */
  onAutoEnd?: () => void
}

const TICK_MS = 50

/** 标点后停顿(毫秒,标准档;按 pauseScale 缩放) */
const PAUSE_AFTER: Array<[RegExp, number]> = [
  [/…/, 600],
  [/[。！？]/, 400],
  [/\n/, 300],
  [/[，、；：]/, 200]
]

export interface Typewriter {
  push(tokens: NarrToken[]): void
  /** 立即显示全部剩余文本、顺序执行剩余指令、跳过停顿,并结束自动会话;之后进入快速模式(新 token 直出直执行) */
  flush(): void
  /** 等待已入队内容自然播完(全文按原速显示 + 剩余指令执行完毕);已 flush/卸载/播完时立即返回 */
  done(): Promise<void>
  /** 停止计时器(页面卸载等) */
  dispose(): void
  /** 已显示文本 */
  readonly display: string
  /** 全部正文(不含指令;token 估算与回合存消息用) */
  readonly fullText: string
}

type ControlToken = Extract<NarrToken, { type: 'device' | 'wave' | 'stop' }>

function tokenToCmd(t: ControlToken): TypewriterCmd {
  if (t.type === 'device') {
    const cmd: TypewriterCmd = { kind: 'dev', function: t.function, intensity: t.intensity }
    if (t.mode !== undefined) cmd.mode = t.mode
    if (t.duration !== undefined) cmd.duration = t.duration
    return cmd
  }
  if (t.type === 'wave') {
    const cmd: TypewriterCmd = { kind: 'wave', function: t.function, pattern: t.pattern }
    if (t.duration !== undefined) cmd.duration = t.duration
    return cmd
  }
  return { kind: 'stop', function: t.function }
}

export function createTypewriter(opts: TypewriterOptions): Typewriter {
  const pauseScale = opts.pauseScale ?? 1
  const perTick = Math.max(1, Math.round((Math.max(1, opts.cps) * TICK_MS) / 1000))

  let tokens: NarrToken[] = []
  let displayText = ''
  let fullText = ''
  let timer: ReturnType<typeof setInterval> | null = null
  let current: NarrToken | null = null
  let textPos = 0
  let holdUntil = 0
  let autoActive = false
  let flushed = false
  let disposed = false
  let naturallyDone = false
  /** done() 的等待方(游戏页流式结束后等待自然播完);自然收尾仅在有待等方时触发 */
  let doneResolvers: (() => void)[] = []

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function resolveDone(): void {
    if (!doneResolvers.length) return
    const rs = doneResolvers
    doneResolvers = []
    for (const r of rs) r()
  }

  /** 自然播完(队列清空且全文已显示):结束自动会话并唤醒 done() 等待方。
   *  仅当存在等待方时收尾,避免流式间隙(暂未推送新 token)误结束自动会话。 */
  function completeNaturally(): void {
    if (naturallyDone || !doneResolvers.length) return
    naturallyDone = true
    if (autoActive) {
      autoActive = false
      opts.onAutoEnd?.()
    }
    resolveDone()
  }

  function execControl(t: ControlToken): void {
    const cmd = tokenToCmd(t)
    void Promise.resolve(opts.onExecute ? opts.onExecute(cmd) : true).then((ok) => {
      // 执行成功且尚未进入自动会话且未收尾 → 开始会话(锁定手动面板);被拒不锁定
      if (ok && !autoActive && !flushed && !naturallyDone) {
        autoActive = true
        opts.onAutoStart?.()
      }
    })
  }

  function ensureRunning(): void {
    if (disposed || flushed || timer) return
    if (!current && !tokens.length) return
    timer = setInterval(tick, TICK_MS)
  }

  function tick(): void {
    if (disposed || flushed) return
    const now = Date.now()
    if (now < holdUntil) return

    // 取下一个 token(控制指令立即执行后继续取;pause 等待)
    while (!current && tokens.length) {
      current = tokens.shift() ?? null
      textPos = 0
      if (!current) break
      if (current.type === 'device' || current.type === 'wave' || current.type === 'stop') {
        const t = current
        current = null
        execControl(t)
        continue
      }
      if (current.type === 'pause') {
        const t = current
        current = null
        holdUntil = now + t.ms * pauseScale
        return
      }
      break
    }
    if (!current) {
      // 队列空:停表等新 token(自动会话持续到自然播完/flush 收尾)
      stopTimer()
      if (displayText === fullText) completeNaturally()
      return
    }

    // 当前为 text:按速率抽取字符显示 + 标点停顿
    const text = (current as { text: string }).text
    const chunk = text.slice(textPos, textPos + perTick)
    displayText += chunk
    textPos += chunk.length
    const lastCh = chunk[chunk.length - 1]
    if (lastCh) {
      for (const [re, ms] of PAUSE_AFTER) {
        if (re.test(lastCh)) {
          holdUntil = now + ms * pauseScale
          break
        }
      }
    }
    opts.onDisplay(displayText)
    if (textPos >= text.length) {
      current = null
      textPos = 0
    }
  }

  return {
    push(newTokens: NarrToken[]): void {
      if (disposed || !newTokens.length) return
      if (flushed) {
        // 快速模式:文本直出,指令直执行,停顿忽略
        for (const t of newTokens) {
          if (t.type === 'text') {
            fullText += t.text
            displayText += t.text
          } else if (t.type === 'device' || t.type === 'wave' || t.type === 'stop') {
            execControl(t)
          }
        }
        opts.onDisplay(displayText)
        return
      }
      for (const t of newTokens) {
        if (t.type === 'text') fullText += t.text
      }
      tokens.push(...newTokens)
      ensureRunning()
    },
    flush(): void {
      if (disposed) return
      stopTimer()
      // 先进入快速模式,再执行剩余指令:避免 flush 批次指令异步结算时误开新会话
      flushed = true
      // 当前 text 剩余部分 + 队列全部 text 立即上屏
      const tail: string[] = []
      if (current && current.type === 'text') {
        tail.push(current.text.slice(textPos))
      }
      for (const t of tokens) {
        if (t.type === 'text') tail.push(t.text)
      }
      if (tail.length) {
        displayText += tail.join('')
        opts.onDisplay(displayText)
      }
      // 顺序执行剩余控制指令(跳过 pause)
      const controls: ControlToken[] = []
      if (current && (current.type === 'device' || current.type === 'wave' || current.type === 'stop')) {
        controls.push(current)
      }
      for (const t of tokens) {
        if (t.type === 'device' || t.type === 'wave' || t.type === 'stop') controls.push(t)
      }
      tokens = []
      current = null
      // 自动会话收尾:仅结束已在流式期间开始的会话;flush 批次新指令不再开锁
      if (controls.length) {
        const jobs = controls.map(t => Promise.resolve(opts.onExecute ? opts.onExecute(tokenToCmd(t)) : true))
        Promise.all(jobs).then(() => {
          if (autoActive) {
            autoActive = false
            opts.onAutoEnd?.()
          }
        })
      } else if (autoActive) {
        autoActive = false
        opts.onAutoEnd?.()
      }
      // 用户跳过:立即唤醒 done() 等待方
      resolveDone()
    },
    done(): Promise<void> {
      if (disposed || flushed) return Promise.resolve()
      // 已自然播完(或此刻即播完):直接完成
      if (!current && !tokens.length && displayText === fullText) {
        completeNaturally()
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        doneResolvers.push(resolve)
      })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopTimer()
      resolveDone()
    },
    get display(): string {
      return displayText
    },
    get fullText(): string {
      return fullText
    }
  }
}
