import { describe, expect, it, vi } from 'vitest'

import { notifyAgentRun, observeAgentRuns, toRunSignal } from './runObserver'

describe('toRunSignal', () => {
  it('认出七种值得旁路知道的事', () => {
    expect(toRunSignal({ channel: 'agent-v3:start', payload: { sessionId: 's' } })).toEqual({
      type: 'started',
      sessionId: 's'
    })
    expect(
      toRunSignal({ channel: 'agent-v3:text', payload: { sessionId: 's', text: '好了' } })
    ).toEqual({ type: 'text', sessionId: 's', text: '好了' })
    expect(
      toRunSignal({
        channel: 'agent-v3:tool-call',
        payload: { sessionId: 's', toolCallId: 'c1', toolName: 'blueprint_compile', args: {} }
      })
    ).toEqual({ type: 'tool', sessionId: 's', toolName: 'blueprint_compile' })
    expect(toRunSignal({ channel: 'agent-v3:done', payload: { sessionId: 's' } })).toEqual({
      type: 'done',
      sessionId: 's'
    })
    expect(toRunSignal({ channel: 'agent-v3:stopped', payload: { sessionId: 's' } })).toEqual({
      type: 'stopped',
      sessionId: 's'
    })
    expect(
      toRunSignal({ channel: 'agent-v3:error', payload: { sessionId: 's', message: '炸了' } })
    ).toEqual({ type: 'error', sessionId: 's', message: '炸了' })
  })

  it('渲染层专属的那些通道不进旁路 —— token 用量对观察者毫无意义', () => {
    expect(
      toRunSignal({
        channel: 'agent-v3:context-usage',
        payload: { sessionId: 's', tokens: 1, contextWindow: 2 }
      })
    ).toBeNull()
    expect(
      toRunSignal({
        channel: 'agent-v3:compacting',
        payload: { sessionId: 's', tokensBefore: 10 }
      })
    ).toBeNull()
  })
})

describe('observeAgentRuns', () => {
  it('退订之后不再收 —— 不摘的话开第二路语音会有两个观察者在收', () => {
    const seen: string[] = []
    const off = observeAgentRuns((signal) => seen.push(signal.type))

    notifyAgentRun({ type: 'done', sessionId: 's' })
    off()
    notifyAgentRun({ type: 'done', sessionId: 's' })

    expect(seen).toEqual(['done'])
  })

  it('观察者抛错不能把 agent 带崩 —— 它是旁路，出问题该死的是它自己', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const survivor = vi.fn()
    const offAngry = observeAgentRuns(() => {
      throw new Error('语音会话已断')
    })
    const offGood = observeAgentRuns(survivor)

    expect(() => notifyAgentRun({ type: 'done', sessionId: 's' })).not.toThrow()
    // 前一个抛了错，后一个照样要收到
    expect(survivor).toHaveBeenCalledOnce()

    offAngry()
    offGood()
    warn.mockRestore()
  })
})
