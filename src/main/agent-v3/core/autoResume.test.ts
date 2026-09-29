import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { describe, expect, it, vi } from 'vitest'

import {
  abortableDelay,
  createAutoResume,
  isRecoverableDisconnect,
  isRetryableUnstable,
  PERSISTENT_RESUME_INTERVAL_MS,
  PERSISTENT_RESUME_MAX_ATTEMPTS,
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
 * 剧本里一项给数组的，是同一次 `continue()` 里接连的几条（先干成一步、再断）。
 */
interface ScriptedAgent {
  state: { messages: AgentMessage[] }
  step: () => Promise<void>
  turns: () => number
}

function scriptedAgent(
  script: Array<AgentMessage | AgentMessage[]>,
  deliver: () => (e: AgentEvent) => void
): ScriptedAgent {
  const state = { messages: [user, toolCall, toolResult] as AgentMessage[] }
  let turn = 0
  const step = async (): Promise<void> => {
    const entry = script[turn++]
    const messages = Array.isArray(entry) ? entry : [entry]
    const emit = deliver()
    for (const message of messages) {
      state.messages = [...state.messages, message]
      emit({ type: 'message_start', message } as AgentEvent)
      emit({ type: 'message_end', message } as AgentEvent)
      emit({ type: 'turn_end', message, toolResults: [] } as AgentEvent)
    }
    emit({ type: 'agent_end', messages } as AgentEvent)
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

function harness(
  script: Array<AgentMessage | AgentMessage[]>,
  signal = new AbortController().signal
): Harness {
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
    'Anthropic stream ended before message_stop',
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

describe('isRetryableUnstable（自动断点续传）', () => {
  it.each([
    'net::ERR_CONNECTION_CLOSED',
    '模型网关连续 3 次扛不住（最后一次：net::ERR_CONNECTION_CLOSED）。',
    '400 {"error":{"code":"model_not_found","message":"当前令牌未覆盖供应商 \\"Anthropic\\"（模型=claude-opus-5-5，已选分组=[aws-q grok-sale kimi-sale]）"}}',
    '503 当前分组 default 下对于模型 claude-opus-5-5 无可用渠道',
    '502 Bad Gateway',
    '429 Too Many Requests',
    '529 {"type":"error","error":{"type":"overloaded_error"}}'
  ])('中转暂时不行，算：%s', (text) => {
    expect(isRetryableUnstable(text)).toBe(true)
  })

  it.each([
    '401 Incorrect API key',
    '429 {"error":{"code":"insufficient_quota"}}',
    '400 context_length_exceeded',
    '400 {"error":{"message":"messages.0.content: Field required"}}',
    // 状态码得在开头：报错正文里碰巧出现的数字不算
    '400 max_tokens must be less than 8500',
    undefined
  ])('重来也一样的，不算：%s', (text) => {
    expect(isRetryableUnstable(text)).toBe(false)
  })
})

describe('createAutoResume 持续模式', () => {
  function persistentHarness(script: Array<AgentMessage | AgentMessage[]>): Harness {
    const delays: number[] = []
    const resume = createAutoResume({
      signal: new AbortController().signal,
      persistent: true,
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
        onScheduled: (n) => {
          expect(n.persistent).toBe(true)
          notices.push(n.attempt)
        },
        onResume: async (plan) => {
          persisted.push(plan.messages)
        },
        resume: agent.step
      })
    return { resume, agent, delivered, delays, notices, persisted, run }
  }

  const gatewayMiss = (): AgentMessage =>
    failure('400 {"error":{"code":"model_not_found","message":"当前令牌未覆盖供应商"}}')

  it('中转没分到线路也接：每 60 秒一次，失败一条都不给界面看', async () => {
    const h = persistentHarness([gatewayMiss(), gatewayMiss(), gatewayMiss(), done])
    await h.run()

    expect(h.agent.turns()).toBe(4)
    expect(h.delays).toEqual([
      PERSISTENT_RESUME_INTERVAL_MS,
      PERSISTENT_RESUME_INTERVAL_MS,
      PERSISTENT_RESUME_INTERVAL_MS
    ])
    expect(h.notices).toEqual([1, 2, 3])
    expect(kinds(h.delivered)).not.toContain('end:error')
    // 上下文里一条失败标记都没留：最后是成功的那句
    expect(h.agent.state.messages).toEqual([user, toolCall, toolResult, done])
  })

  it('连续失败到上限才报错，报的只有最后那一次', async () => {
    const script = Array.from({ length: PERSISTENT_RESUME_MAX_ATTEMPTS + 1 }, gatewayMiss)
    const h = persistentHarness(script)
    await h.run()

    expect(h.resume.attempts).toBe(PERSISTENT_RESUME_MAX_ATTEMPTS)
    expect(kinds(h.delivered).filter((k) => k === 'end:error')).toHaveLength(1)
  })

  it('中间成功回过一次话，计数清零', async () => {
    // 续跑成功干完一步（调用 + 结果），同一次 continue() 里又断了
    const call2 = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c2', name: 'run_shell_command', arguments: {} }],
      stopReason: 'toolUse'
    } as unknown as AgentMessage
    const result2 = {
      role: 'toolResult',
      toolCallId: 'c2',
      content: [{ type: 'text', text: 'ok' }]
    } as unknown as AgentMessage
    const streak = (n: number): AgentMessage[] => Array.from({ length: n }, gatewayMiss)
    const max = PERSISTENT_RESUME_MAX_ATTEMPTS
    // 先连着断 max-1 次，续跑成功一步又断，再连着断 max-1 次，最后成了
    const h = persistentHarness([
      ...streak(max - 1),
      [call2, result2, gatewayMiss()],
      ...streak(max - 1),
      done
    ])
    await h.run()

    // 不清零的话总共 2max-1 次早就超了上限，最后一次失败会被放给界面
    expect(h.delays).toHaveLength(2 * max - 1)
    expect(kinds(h.delivered)).not.toContain('end:error')
    expect(h.agent.state.messages.at(-1)).toBe(done)
  })

  it('余额不足：不接，照常报', async () => {
    const h = persistentHarness([failure('429 {"error":{"code":"insufficient_quota"}}')])
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
