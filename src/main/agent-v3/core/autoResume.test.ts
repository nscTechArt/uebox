import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { describe, expect, it, vi } from 'vitest'

import {
  abortableDelay,
  createAutoResume,
  isRecoverableDisconnect,
  type AutoResume
} from './autoResume'

const user = { role: 'user', content: '搭个场景', timestamp: 0 } as unknown as AgentMessage
const toolCall = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'c1', name: 'run_shell_command', arguments: {} }],
  stopReason: 'toolUse'
} as unknown as AgentMessage
const toolResult = {
  role: 'toolResult',
  toolCallId: 'c1',
  content: [{ type: 'text', text: 'ok fir_tree_01.blend' }]
} as unknown as AgentMessage

function failure(errorMessage: string): AgentMessage {
  return {
    role: 'assistant',
    // 失败那条回话里带着半截工具调用 —— 续跑前必须连它一起摘掉
    content: [{ type: 'toolCall', id: 'half', name: 'run_shell_command', arguments: {} }],
    stopReason: 'error',
    errorMessage
  } as unknown as AgentMessage
}

const done: AgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '好了' }],
  stopReason: 'stop'
} as unknown as AgentMessage

/**
 * 一个最小的 agent：每跑一次按剧本吐一条回话，像 pi 那样发事件、把回话压进 messages。
 */
interface ScriptedAgent {
  state: { messages: AgentMessage[] }
  step: () => Promise<void>
  turns: () => number
}

function scriptedAgent(
  script: AgentMessage[],
  deliver: () => (e: AgentEvent) => void
): ScriptedAgent {
  const state = { messages: [user, toolCall, toolResult] as AgentMessage[] }
  let turn = 0
  const step = async (): Promise<void> => {
    const message = script[turn++]
    state.messages = [...state.messages, message]
    const emit = deliver()
    emit({ type: 'message_start', message } as AgentEvent)
    emit({ type: 'message_end', message } as AgentEvent)
    emit({ type: 'turn_end', message, toolResults: [] } as AgentEvent)
    emit({ type: 'agent_end', messages: [message] } as AgentEvent)
  }
  return { state, step, turns: () => turn }
}

interface Harness {
  resume: AutoResume
  agent: ScriptedAgent
  delivered: AgentEvent[]
  delays: number[]
  notices: number[]
  persisted: AgentMessage[][]
  run: () => Promise<void>
}

function harness(script: AgentMessage[], signal = new AbortController().signal): Harness {
  const delays: number[] = []
  const resume = createAutoResume({
    signal,
    delay: async (ms) => {
      delays.push(ms)
    }
  })
  const delivered: AgentEvent[] = []
  const deliver = resume.wrap((e) => delivered.push(e))
  const agent = scriptedAgent(script, () => deliver)
  const notices: number[] = []
  const persisted: AgentMessage[][] = []
  const run = (): Promise<void> =>
    resume.run(agent.step, agent, {
      onScheduled: (n) => notices.push(n.attempt),
      onResume: async (plan) => {
        persisted.push(plan.messages)
      },
      resume: agent.step
    })
  return { resume, agent, delivered, delays, notices, persisted, run }
}

const kinds = (events: AgentEvent[]): string[] =>
  events.map((e) =>
    e.type === 'message_end'
      ? `end:${(e.message as { stopReason?: string }).stopReason}`
      : e.type === 'agent_end'
        ? 'agent_end'
        : e.type
  )

describe('isRecoverableDisconnect', () => {
  it.each([
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_RESET',
    'read ECONNRESET',
    'socket hang up',
    'terminated',
    '模型网关回话中途断流，这一次的回话没收完'
  ])('连接中断算：%s', (text) => {
    expect(isRecoverableDisconnect(text)).toBe(true)
  })

  it.each([
    '401 Incorrect API key',
    '429 Too Many Requests',
    'context_length_exceeded',
    '模型网关连续 3 次扛不住（最后一次：net::ERR_CONNECTION_CLOSED）。',
    undefined
  ])('别的失败不算：%s', (text) => {
    expect(isRecoverableDisconnect(text)).toBe(false)
  })
})

describe('createAutoResume', () => {
  it('断一次：扣下失败、等一会儿、摘掉失败标记和半截调用后接着跑', async () => {
    const h = harness([failure('net::ERR_CONNECTION_CLOSED'), done])
    await h.run()

    expect(h.agent.turns()).toBe(2)
    expect(h.delays).toEqual([10_000])
    expect(h.notices).toEqual([1])
    // 续跑用的上下文停在工具结果上：做完的那步留着，半截调用没了
    expect(h.persisted[0]).toEqual([user, toolCall, toolResult])
    // 界面没见过那次失败，也没见过一次提前的「结束」
    expect(kinds(h.delivered)).not.toContain('end:error')
    expect(kinds(h.delivered).filter((k) => k === 'agent_end')).toHaveLength(1)
    expect(h.agent.state.messages.at(-1)).toBe(done)
  })

  it('最多两次，一次比一次等得久；第三次断照常报错', async () => {
    const h = harness([
      failure('net::ERR_CONNECTION_CLOSED'),
      failure('net::ERR_CONNECTION_CLOSED'),
      failure('net::ERR_CONNECTION_CLOSED')
    ])
    await h.run()

    expect(h.agent.turns()).toBe(3)
    expect(h.delays).toEqual([10_000, 30_000])
    expect(h.resume.attempts).toBe(2)
    // 最后那次放出去了：界面照常看到失败和结束，留着「继续尝试」
    expect(kinds(h.delivered)).toEqual(expect.arrayContaining(['end:error', 'agent_end']))
    expect(kinds(h.delivered).filter((k) => k === 'end:error')).toHaveLength(1)
  })

  it('不是连接中断的失败：不扣、不续跑', async () => {
    const h = harness([failure('401 Incorrect API key')])
    await h.run()

    expect(h.agent.turns()).toBe(1)
    expect(h.delays).toEqual([])
    expect(kinds(h.delivered)).toContain('end:error')
  })

  it('等待期间点停止：立刻结束，不再续跑', async () => {
    const controller = new AbortController()
    const resume = createAutoResume({ signal: controller.signal })
    const delivered: AgentEvent[] = []
    const deliver = resume.wrap((e) => delivered.push(e))
    const agent = scriptedAgent([failure('net::ERR_CONNECTION_CLOSED'), done], () => deliver)
    const resumed = vi.fn()

    const running = resume.run(agent.step, agent, {
      onScheduled: () => controller.abort(),
      onResume: async () => {},
      resume: resumed
    })

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(resumed).not.toHaveBeenCalled()
    expect(agent.turns()).toBe(1)
  })

  it('已经停下的一轮：失败也不扣', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness([failure('net::ERR_CONNECTION_CLOSED')], controller.signal)
    await h.run()
    expect(h.delays).toEqual([])
    expect(kinds(h.delivered)).toContain('end:error')
  })
})

describe('abortableDelay', () => {
  it('到点返回', async () => {
    vi.useFakeTimers()
    const waiting = abortableDelay(1000, new AbortController().signal)
    vi.advanceTimersByTime(1000)
    await expect(waiting).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('中止立刻拒绝', async () => {
    const controller = new AbortController()
    const waiting = abortableDelay(60_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })
})
