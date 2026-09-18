import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcHandlers = new Set<(...args: unknown[]) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (_channel: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers.add(handler)
    },
    removeListener: (_channel: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers.delete(handler)
    }
  }
}))

import {
  createQuestionRequester,
  hasPendingQuestion,
  resendPendingQuestions,
  type AskUserQuestion,
  type QuestionAction,
  type QuestionRequest
} from './questionChannel'

interface FakeSender {
  id: number
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  once: (event: string, handler: () => void) => void
  off: (event: string, handler: () => void) => void
  /** 模拟窗口被销毁：应用关窗后留在托盘，主进程还活着，但这张卡片没人能答了 */
  destroy: () => void
}

function fakeSender(id: number): FakeSender {
  const listeners = new Set<() => void>()
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: (_event, handler) => {
      listeners.add(handler)
    },
    off: (_event, handler) => {
      listeners.delete(handler)
    },
    destroy: () => {
      for (const handler of [...listeners]) handler()
    }
  }
}

function questions(): AskUserQuestion[] {
  return [
    {
      header: '用在哪',
      question: 'TTS 适配器接上之后先给谁用？',
      multiSelect: false,
      options: [
        { label: '补适配层（推荐）', description: '只加能力位，不改现有行为' },
        { label: '顺带改音频概览', description: '改动面更大，会碰到产出流程' }
      ]
    }
  ]
}

function request(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    sessionId: 'session-1',
    toolCallId: 'call-1',
    questions: questions(),
    ...overrides
  }
}

/** 回复一次提问：模拟渲染层点了按钮 */
function reply(toolCallId: string, action: QuestionAction, answers?: string[]): void {
  for (const handler of [...ipcHandlers]) {
    handler({} as never, { toolCallId, action, answers })
  }
}

describe('createQuestionRequester', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipcHandlers.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('把提问发给渲染层，并在回复后返回用户的选择', async () => {
    const sender = fakeSender(1)
    const ask = createQuestionRequester(sender as never)

    const pending = ask(request())

    expect(sender.send).toHaveBeenCalledWith('agent-v3:question-required', {
      sessionId: 'session-1',
      toolCallId: 'call-1',
      questions: questions()
    })

    reply('call-1', 'accept', ['补适配层（推荐）'])

    await expect(pending).resolves.toEqual({
      action: 'accept',
      answers: ['补适配层（推荐）']
    })
  })

  /**
   * 并发的两次提问不能串线。
   *
   * `toolExecution: 'parallel'` 下可能同时有别的往返在等，用 `ipcMain.once`
   * 的话第一条回复会被随便哪个监听器吃掉 —— V2 的 token 刷新握手踩过这个坑。
   */
  it('按 toolCallId 匹配回复，不会串线', async () => {
    const sender = fakeSender(1)
    const ask = createQuestionRequester(sender as never)

    const first = ask(request({ toolCallId: 'call-1' }))
    const second = ask(request({ toolCallId: 'call-2' }))

    reply('call-2', 'accept', ['第二个'])
    await expect(second).resolves.toEqual({ action: 'accept', answers: ['第二个'] })

    reply('call-1', 'accept', ['第一个'])
    await expect(first).resolves.toEqual({ action: 'accept', answers: ['第一个'] })
  })

  /**
   * decline 不能被当成 cancel。
   *
   * 「我懒得选，你自己定」和「这事先停一停」对模型的指示正好相反：
   * 前者让它带着假设继续，后者让它停下来等人。
   */
  it('decline 原样透传，且不带答案', async () => {
    const sender = fakeSender(1)
    const pending = createQuestionRequester(sender as never)(request())

    reply('call-1', 'decline', ['不该被采信的答案'])

    await expect(pending).resolves.toEqual({ action: 'decline' })
  })

  /**
   * **没有超时**：没人回答就一直等着。
   *
   * 这里原来有个 30 分钟的兜底，到点按取消。取消掉了 —— 用户没回答不代表他放弃，
   * 只代表他还没回来。替他判「这事不做了」比一直等更糟，在目标模式下尤其糟：
   * 一次超时会让整条目标线索在他毫不知情的情况下结束。
   */
  it('没人回答就一直等，不自己超时', async () => {
    const sender = fakeSender(1)
    let settled = false
    const pending = createQuestionRequester(sender as never)(request())
    void pending.then(() => {
      settled = true
    })

    // 远超原来那个 30 分钟
    vi.advanceTimersByTime(4 * 60 * 60_000)
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(hasPendingQuestion('session-1')).toBe(true)

    // 人回来了，照样答得上
    reply('call-1', 'accept', ['补适配层（推荐）'])
    await expect(pending).resolves.toEqual({
      action: 'accept',
      answers: ['补适配层（推荐）']
    })
  })

  /**
   * 窗口没了按取消 —— 去掉超时之后**唯一**还会卡死的路径。
   *
   * 关窗后应用留在托盘，主进程还活着，而补发按 senderId 过滤，重开窗口是新的
   * WebContents、新的 id，认不出这条。不收掉的话这次运行会一直挂着攥着资产锁。
   * 这不算替用户做主：能让他回答的界面已经不存在了。
   */
  it('所属窗口被销毁时按取消处理', async () => {
    const sender = fakeSender(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pending = createQuestionRequester(sender as never)(request())

    sender.destroy()

    await expect(pending).resolves.toEqual({ action: 'cancel' })
    expect(hasPendingQuestion('session-1')).toBe(false)
    warn.mockRestore()
  })

  /** 用户按停止 / 删除会话：这一轮整个不作数，不是「他拒绝回答」 */
  it('abort 按取消处理', async () => {
    const sender = fakeSender(1)
    const controller = new AbortController()
    const pending = createQuestionRequester(sender as never)(request(), controller.signal)

    controller.abort()

    await expect(pending).resolves.toEqual({ action: 'cancel' })
  })

  it('窗口已销毁时立刻按取消返回，不发事件', async () => {
    const sender = { id: 1, isDestroyed: () => true, send: vi.fn() }
    const pending = createQuestionRequester(sender as never)(request())

    await expect(pending).resolves.toEqual({ action: 'cancel' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  /** 认不出的 action 一律当取消 —— 宁可停下来，也不能凭一个坏值继续干活 */
  it('非法 action 当作取消', async () => {
    const sender = fakeSender(1)
    const pending = createQuestionRequester(sender as never)(request())

    reply('call-1', 'nonsense' as QuestionAction, ['x'])

    await expect(pending).resolves.toEqual({ action: 'cancel' })
  })
})

/**
 * 提问卡片必须能在刷新之后补发。
 *
 * 和审批同理：agent 跑在主进程，刷新只重启了界面 —— 卡片没了，主进程还阻塞在
 * `ask_user` 里等回复。不补发就一直等到超时，用户看到的是「刷新之后 agent
 * 卡住不动，最后说没人回答」，而他从头到尾没看见过那张卡片。
 */
describe('resendPendingQuestions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipcHandlers.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('补发本窗口、指定会话的待回答提问', () => {
    const sender = fakeSender(7)
    const ask = createQuestionRequester(sender as never)
    void ask(request({ sessionId: 'session-a', toolCallId: 'a' }))
    void ask(request({ sessionId: 'session-b', toolCallId: 'b' }))
    sender.send.mockClear()

    expect(resendPendingQuestions(sender as never, ['session-a'])).toBe(1)
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send.mock.calls[0][1]).toMatchObject({ sessionId: 'session-a' })

    reply('a', 'cancel')
    reply('b', 'cancel')
  })

  /** 审批只对发起它的那个窗口有意义 —— 别的窗口收到会弹一个它没在跑的东西 */
  it('不补发别的窗口的提问', () => {
    const owner = fakeSender(1)
    void createQuestionRequester(owner as never)(request({ toolCallId: 'owned' }))

    const other = fakeSender(2)
    expect(resendPendingQuestions(other as never, ['session-1'])).toBe(0)
    expect(other.send).not.toHaveBeenCalled()

    reply('owned', 'cancel')
  })

  it('回答之后不再补发', async () => {
    const sender = fakeSender(3)
    const pending = createQuestionRequester(sender as never)(request({ toolCallId: 'done' }))
    reply('done', 'accept', ['选了'])
    await pending

    expect(resendPendingQuestions(sender as never, ['session-1'])).toBe(0)
  })
})

/** 挡住并发提问的那道闸读的就是它 */
describe('hasPendingQuestion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipcHandlers.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂着时为 true，答完为 false', async () => {
    const sender = fakeSender(4)
    expect(hasPendingQuestion('session-1')).toBe(false)

    const pending = createQuestionRequester(sender as never)(request({ toolCallId: 'p' }))
    expect(hasPendingQuestion('session-1')).toBe(true)
    expect(hasPendingQuestion('session-other')).toBe(false)

    reply('p', 'accept', ['x'])
    await pending
    expect(hasPendingQuestion('session-1')).toBe(false)
  })
})
