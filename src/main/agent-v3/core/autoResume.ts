/**
 * 模型连接中途被掐断时，自动「继续尝试」有限几次。
 *
 * ## 为什么要有它
 *
 * 真机：一条会话跑了四十多分钟（下载模型、搭场景、铺材质），模型正写到下一步的
 * 下载脚本时，网关把连接掐了（`net::ERR_CONNECTION_CLOSED`）。之前做的全都还在，
 * 缺的只是**这一次回话**，而整条任务停下来等用户回来点「继续尝试」。
 *
 * `requestGate.ts` 的卡死重发管不了这种：它只在**还没往下游推过任何内容**时重发，
 * 推过半截再重来，界面会看到重复的开头。这里在更外面一层接手 —— 这一轮已经以
 * 失败收尾之后，走和「继续尝试」同一条路（`planResume` 摘掉失败标记，再
 * `agent.continue()`），只是不用人点。
 *
 * ## 安全边界
 *
 * - **只认连接中断。** 鉴权、参数、上下文超长、限流一概不接：重来一遍结果一样，
 *   只会把失败拖晚。
 * - **失败那条回话里的工具调用不会执行。** pi 在 `stopReason: 'error'` 时直接收尾，
 *   不进工具执行（agent-loop 的那条 return）；续跑前 `planResume` 又把这条连同
 *   它的半截调用一起摘掉。
 * - **做完的工具不会重跑。** 续跑从最后一条工具结果接着往下，建模、下载的结果
 *   原样留在上下文里，内核不会回头再执行它们。
 * - **最多两次，一次比一次等得久。** 网关在挤的时候，马上重来正是把它再次打满的方式。
 * - **用户点停止立即结束**：等待本身挂在这一轮的中止信号上。
 *
 * 这提高的是任务跑完的概率，不是让断线消失 —— 两次都断，照常报错、照常留
 * 「继续尝试」按钮。
 */

import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'

import { planResume, type ResumePlan } from './resume'

/** 第 n 次自动续跑前等多久。数组长度就是次数上限 */
export const AUTO_RESUME_DELAYS_MS: readonly number[] = [10_000, 30_000]

/**
 * 算「连接中断」的报错。
 *
 * - `ERR_*`：Chromium 网络栈（走系统代理的请求由它发，见 `systemProxyFetch.ts`）
 * - `ECONNRESET` / `socket hang up` / `terminated` / `other side closed`：Node 直连（undici）
 * - 最后一条是 `requestGate.ts` 自己的：推过内容之后包间隔超时
 *
 * 超时类（`ERR_TIMED_OUT`）不在这里：没有首包那种卡死重发已经管了，
 * 中途超时由最后一条覆盖。
 */
const DISCONNECT_TEXT =
  /ERR_CONNECTION_(CLOSED|RESET|ABORTED)|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_HTTP2_PROTOCOL_ERROR|ERR_INCOMPLETE_CHUNKED_ENCODING|ECONNRESET|socket hang up|\bterminated\b|other side closed|这一次的回话没收完/i

/**
 * `requestGate` 已经重发到头的那句（「连续 N 次扛不住（最后一次：…ERR_CONNECTION_CLOSED）」）。
 * 里面带着断线原文，但它说的是**接都接不通**，卡死重发已经试过几轮了 ——
 * 再在外面乘两次，一次失败会变成九次请求。
 */
const GATE_EXHAUSTED = /模型网关连续 \d+ 次扛不住/

export function isRecoverableDisconnect(errorMessage: string | undefined): boolean {
  return !!errorMessage && !GATE_EXHAUSTED.test(errorMessage) && DISCONNECT_TEXT.test(errorMessage)
}

/** 等一会儿；中止信号一到立刻以它的原因拒绝 —— 调用方按「用户停下」处理 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface AutoResumeNotice {
  /** 第几次，从 1 开始 */
  attempt: number
  maxAttempts: number
  delayMs: number
  /** 这次断开的原文，只给日志和界面看 */
  reason: string
}

interface AgentLike {
  state: { messages: AgentMessage[] }
}

export interface AutoResumeHooks {
  /** 开始等之前：告诉界面和日志 */
  onScheduled: (notice: AutoResumeNotice) => void
  /** 摘完失败标记、真要续跑之前：落盘、重置这一轮的收尾状态 */
  onResume: (plan: Extract<ResumePlan, { ok: true }>) => Promise<void>
  /** 真正接着跑：和「继续尝试」同一个调用（`agent.continue()`，带上这一轮的作用域） */
  resume: () => Promise<void>
}

export interface AutoResume {
  /** 这一轮已经自动续跑了几次。诊断日志要记 */
  readonly attempts: number
  /** 包住事件桥，之后所有事件经它转交 */
  wrap(deliver: (event: AgentEvent) => void): (event: AgentEvent) => void
  /** 包住 `agent.prompt()` / `agent.continue()`，按需自动续跑 */
  run(first: () => Promise<void>, agent: AgentLike, hooks: AutoResumeHooks): Promise<void>
}

export interface AutoResumeDeps {
  /** 这一轮的中止信号（用户点停止就触发） */
  signal: AbortSignal
  delaysMs?: readonly number[]
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * 一轮运行一个。
 *
 * 用法分两半，因为「这次失败接不接」必须在失败事件**到达界面之前**就定下来：
 *
 * 1. `deliver = wrap(bridge)`，之后所有事件经 `deliver` 送进事件桥。看到失败那条
 *    回话时当场决定；决定接着跑，就把这条回话的结束和随后的整轮结束**先扣下**——
 *    界面不会先弹一张失败卡片、再看着它自己好了。
 * 2. `run(first, agent, hooks)` 包住 `agent.prompt()` / `agent.continue()`。
 *    跑完如果正扣着一次失败，就等、摘失败标记、接着跑。
 *
 * 决定只在事件到达时做一次，`run` 只照办 —— 两处各判一遍，迟早会出现
 * 「事件扣下了、却没续跑」，界面就永远停在转圈上。万一续跑计划做不出来，
 * 扣下的事件原样放出去，和没有这一层时一模一样。
 *
 * 用户在等待期间点停止：扣下的事件直接丢掉，调用方的中止收尾会补一条「已停止」。
 */
export function createAutoResume(deps: AutoResumeDeps): AutoResume {
  const delays = deps.delaysMs ?? AUTO_RESUME_DELAYS_MS
  const delay = deps.delay ?? abortableDelay
  let used = 0
  let pending: string | undefined
  let held: AgentEvent[] = []
  let sink: ((event: AgentEvent) => void) | undefined

  const decide = (event: AgentEvent): boolean => {
    if (event.type !== 'message_end') return false
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string }
    if (message.role !== 'assistant' || message.stopReason !== 'error') return false
    pending =
      used < delays.length && !deps.signal.aborted && isRecoverableDisconnect(message.errorMessage)
        ? (message.errorMessage ?? '')
        : undefined
    return pending !== undefined
  }

  return {
    get attempts(): number {
      return used
    },

    wrap(deliver: (event: AgentEvent) => void): (event: AgentEvent) => void {
      sink = deliver
      return (event) => {
        if (decide(event) || (pending !== undefined && event.type === 'agent_end')) {
          held.push(event)
          return
        }
        deliver(event)
      }
    },

    async run(first, agent, hooks): Promise<void> {
      await first()
      while (pending !== undefined) {
        const reason = pending
        const plan = planResume(agent.state.messages)
        if (!plan.ok) {
          pending = undefined
          const release = held
          held = []
          for (const event of release) sink?.(event)
          return
        }
        const delayMs = delays[used]
        used += 1
        hooks.onScheduled({ attempt: used, maxAttempts: delays.length, delayMs, reason })
        // 停止在这里就是一个拒绝：调用方的 catch 按用户中止收尾
        await delay(delayMs, deps.signal)
        pending = undefined
        held = []
        await hooks.onResume(plan)
        agent.state.messages = plan.messages
        await hooks.resume()
      }
    }
  }
}
