import { describe, expect, it, vi } from 'vitest'
import { countUserTurnsBefore, rewindTranscript } from './transcriptRewind'

/**
 * 重发前把内核 transcript 倒回去。这里守的是两件事：数对回合数
 * （数错一位模型就少记或多记一整轮），以及截断失败时不能把用户的重发拦下来。
 */
describe('countUserTurnsBefore', () => {
  const conversation = [
    { role: 'user' }, // 0
    { role: 'assistant' }, // 1
    { role: 'user' }, // 2
    { role: 'assistant' }, // 3
    { role: 'user' }, // 4
    { role: 'assistant' } // 5
  ]

  it('要重发的那条自己不算 —— 算进去内核里会出现两条一样的提问', () => {
    expect(countUserTurnsBefore(conversation, 4)).toBe(2)
    expect(countUserTurnsBefore(conversation, 2)).toBe(1)
  })

  it('重发第一条时前面一个回合都不留', () => {
    expect(countUserTurnsBefore(conversation, 0)).toBe(0)
    expect(countUserTurnsBefore(conversation, -1)).toBe(0)
  })

  it('只数用户消息，回复和过程消息不算回合', () => {
    expect(countUserTurnsBefore(conversation, conversation.length)).toBe(3)
  })
})

describe('rewindTranscript', () => {
  it('把会话 id 和回合数原样交给内核', async () => {
    const truncate = vi.fn().mockResolvedValue({ success: true, messageCount: 2, dropped: 2 })

    const result = await rewindTranscript('agent-a', 1, truncate)

    expect(truncate).toHaveBeenCalledWith('agent-a', 1)
    expect(result).toMatchObject({ success: true, dropped: 2 })
  })

  it('没有 agentSessionId 的会话（普通对话、知识库聊天）直接跳过', async () => {
    const truncate = vi.fn()

    expect(await rewindTranscript(null, 1, truncate)).toBeUndefined()
    expect(await rewindTranscript(undefined, 1, truncate)).toBeUndefined()
    expect(truncate).not.toHaveBeenCalled()
  })

  it('内核报 missing 不算异常 —— 第一轮就点重新生成时本来就没历史可截', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const truncate = vi.fn().mockResolvedValue({ success: false, reason: 'missing' })

    await rewindTranscript('agent-a', 0, truncate)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('截断失败只留日志，不把异常抛给调用方 —— 重发不能因为它被拦下', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const truncate = vi.fn().mockRejectedValue(new Error('disk full'))

    const result = await rewindTranscript('agent-a', 1, truncate)

    expect(result).toEqual({ success: false, error: 'disk full' })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('会话正在跑时留一条警告，让日志里能看出这一轮带了旧上下文', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const truncate = vi.fn().mockResolvedValue({ success: false, reason: 'busy' })

    await rewindTranscript('agent-a', 1, truncate)

    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
