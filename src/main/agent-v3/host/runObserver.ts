/**
 * 主进程内部观察 agent 运行的一个口子。
 *
 * ## 为什么需要它
 *
 * 语音前台要在任务跑的时候插播进度（「在改蓝图了」「失败了」），
 * 而进度只存在于**发往渲染层的那条流**里 —— 主进程自己没有留副本。
 * 于是要么让语音层去 renderer 绕一圈再回来，要么在这里开个旁路。
 *
 * ## 为什么不是让 agent-v3 直接调语音
 *
 * agent-v3 不该知道有语音这回事：语音是可选功能，没配也要能跑；
 * 反过来依赖的话，删掉语音就要动 agent 的核心代码。
 * 这里只广播「发生了什么」，谁要听谁自己订。
 *
 * ## 信号为什么另起一套形状
 *
 * 没有直接广播 `AgentV3Event`：那是**渲染层的契约**，有二十来个通道，
 * 其中大半（token 用量、上下文水位、流式增量）对旁路观察者毫无意义。
 * 原样转发的话，每个观察者都要先写一遍同样的过滤，而且渲染层契约一改
 * 就会牵连它们。这里收敛成七种「值得别人知道」的信号。
 */

import type { AgentQuestion } from '../../../shared/agentQuestion'

import type { AgentV3Event } from './eventBridge'

/** 一次 agent 运行里值得旁路观察者知道的事 */
export type AgentRunSignal =
  | { type: 'started'; sessionId: string }
  /** 助手正文增量。攒起来就是这一轮的回答 */
  | { type: 'text'; sessionId: string; text: string }
  /** 开始执行某个工具。用来说「现在在做什么」 */
  | { type: 'tool'; sessionId: string; toolName: string }
  /** agent 反问用户，正卡在这儿等答案 */
  | { type: 'question'; sessionId: string; toolCallId: string; questions: AgentQuestion[] }
  /** 那一问有结果了（答了、拒了、或整轮取消了） */
  | { type: 'question-settled'; sessionId: string; toolCallId: string }
  /**
   * agent 要做一件需要用户点头的事，正卡在审批上。
   *
   * 比反问更要紧：反问超时按取消算，审批**超时按拒绝算**，而且要等五分钟。
   * 用户戴着耳机没看屏幕的话，那五分钟里他完全不知道有个确认框在等他，
   * 最后只听说「这一步被拒绝了」—— 而他从头到尾没点过拒绝。
   */
  | {
      type: 'approval'
      sessionId: string
      toolCallId: string
      toolName: string
      risk: string
      allowAlways: boolean
    }
  /** 那一次审批有结果了（批了、拒了、超时、或整轮取消了） */
  | { type: 'approval-settled'; sessionId: string; toolCallId: string }
  /**
   * agent 自己开口汇报进度（`voice_report` 工具）。
   *
   * 和 `tool` 那条「在改蓝图」的机械进度不同：这一句是干活的模型自己写的口语，
   * 带状态 —— running 是中途，done/blocked 是收尾。语音那边按状态定念的优先级。
   */
  | {
      type: 'report'
      sessionId: string
      status: 'running' | 'done' | 'blocked'
      message: string
    }
  | { type: 'done'; sessionId: string }
  | { type: 'stopped'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string }
  /**
   * 这条会话**真的**空出来了：主进程把它从 `activeAgents` 摘掉、锁也放了。
   *
   * 和 `done` 不是一回事。`done` 是 agent 事件流里的最后一条，但它发出来的时候
   * `prompt()` 还没返回、`finally` 里的 release 还没跑 —— 这会儿往同一条会话
   * 派新一轮，收到的是「正在执行中」。要接着往这条会话派活的，等这条。
   */
  | { type: 'released'; sessionId: string }

export type AgentRunObserver = (signal: AgentRunSignal) => void

const observers = new Set<AgentRunObserver>()

/** 订阅。返回退订函数 —— 不退订的话换一路语音会话会有两个观察者在收 */
export function observeAgentRuns(observer: AgentRunObserver): () => void {
  observers.add(observer)
  return () => observers.delete(observer)
}

/**
 * 广播。
 *
 * 观察者抛异常不能把 agent 带崩 —— 它是旁路，出了问题该死的是它自己。
 */
export function notifyAgentRun(signal: AgentRunSignal): void {
  for (const observer of observers) {
    try {
      observer(signal)
    } catch (error) {
      console.warn('[AgentRunObserver] 观察者抛错，已忽略:', error)
    }
  }
}

/**
 * 渲染层事件 → 旁路信号。没有对应信号的返回 null。
 *
 * 单独导出是为了可测：漏掉 `done` 的话语音会永远说「还在跑」，
 * 而这种错不报任何异常。
 */
export function toRunSignal(event: AgentV3Event): AgentRunSignal | null {
  switch (event.channel) {
    case 'agent-v3:start':
      return { type: 'started', sessionId: event.payload.sessionId }
    case 'agent-v3:text':
      return { type: 'text', sessionId: event.payload.sessionId, text: event.payload.text }
    case 'agent-v3:tool-call':
      return {
        type: 'tool',
        sessionId: event.payload.sessionId,
        toolName: event.payload.toolName
      }
    case 'agent-v3:question-required':
      return {
        type: 'question',
        sessionId: event.payload.sessionId,
        toolCallId: event.payload.toolCallId,
        questions: event.payload.questions
      }
    case 'agent-v3:done':
      return { type: 'done', sessionId: event.payload.sessionId }
    case 'agent-v3:stopped':
      return { type: 'stopped', sessionId: event.payload.sessionId }
    case 'agent-v3:error':
      return { type: 'error', sessionId: event.payload.sessionId, message: event.payload.message }
    default:
      return null
  }
}
