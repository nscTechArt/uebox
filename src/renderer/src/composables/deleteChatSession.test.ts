import { describe, expect, it, vi } from 'vitest'

import { isSessionTab } from '@renderer/common/chatRoute'

import {
  deleteChatSession,
  deleteChatSessions,
  type ChatSessionTab,
  type DeleteChatSessionDeps,
  type DeleteChatSessionsDeps
} from './deleteChatSession'

/**
 * 删除会话必须三处一起清。
 *
 * 这条路原来只做了「从侧边栏数组里 splice 掉」——列表里不见了，消息还在
 * localStorage、内核记忆还在盘上的 JSONL。用户点了删除却没删掉，涉及隐私时
 * 这是个正确性问题，不是整洁度问题。
 */
function makeDeps(overrides: Partial<DeleteChatSessionDeps> = {}): {
  deps: DeleteChatSessionDeps
  calls: {
    deleteTranscript: ReturnType<typeof vi.fn>
    dropMessages: ReturnType<typeof vi.fn>
    removeSession: ReturnType<typeof vi.fn>
    closeTab: ReturnType<typeof vi.fn>
  }
} {
  const calls = {
    deleteTranscript: vi.fn(async () => ({ success: true })),
    dropMessages: vi.fn(),
    removeSession: vi.fn(),
    closeTab: vi.fn()
  }

  return {
    calls,
    deps: {
      sessionId: 'chat-1',
      agentSessionId: 'agent-1',
      deleteTranscript: calls.deleteTranscript,
      dropMessages: calls.dropMessages,
      removeSession: calls.removeSession,
      listTabs: (): ChatSessionTab[] => [],
      closeTab: calls.closeTab,
      ...overrides
    }
  }
}

describe('deleteChatSession', () => {
  it('三处都清：内核记忆、消息、会话本身', async () => {
    const { deps, calls } = makeDeps()

    await deleteChatSession(deps)

    expect(calls.deleteTranscript).toHaveBeenCalledWith('agent-1')
    expect(calls.dropMessages).toHaveBeenCalledWith('chat-1')
    expect(calls.removeSession).toHaveBeenCalledWith('chat-1')
  })

  /**
   * 顺序不是随意的：先删盘上的，再清界面。
   * 反过来的话，中途崩溃会留下一个「看不见但还在」的 JSONL。
   */
  it('先删盘上的，再清界面', async () => {
    const order: string[] = []
    const { deps } = makeDeps({
      deleteTranscript: async () => {
        order.push('transcript')
        return { success: true }
      },
      dropMessages: () => order.push('messages'),
      removeSession: () => order.push('session')
    })

    await deleteChatSession(deps)

    expect(order).toEqual(['transcript', 'messages', 'session'])
  })

  it('从没跑过 Agent 的会话不去碰盘', async () => {
    const { deps, calls } = makeDeps({ agentSessionId: undefined })

    await deleteChatSession(deps)

    expect(calls.deleteTranscript).not.toHaveBeenCalled()
    expect(calls.removeSession).toHaveBeenCalledWith('chat-1')
  })

  /**
   * 内核记忆删失败也要继续清界面 —— 会话已经在用户眼里"删了"，
   * 留在列表里只会让人以为点击没生效。但失败必须报上去。
   */
  it('删内核记忆失败：界面照清，错误照报', async () => {
    const { deps, calls } = makeDeps({
      deleteTranscript: async () => ({ success: false, error: '会话正在执行中' })
    })

    const result = await deleteChatSession(deps)

    expect(result.transcriptError).toBe('会话正在执行中')
    expect(calls.removeSession).toHaveBeenCalledWith('chat-1')
  })

  it('IPC 直接抛异常也不阻断删除', async () => {
    const { deps, calls } = makeDeps({
      deleteTranscript: async () => {
        throw new Error('主进程没响应')
      }
    })

    const result = await deleteChatSession(deps)

    expect(result.transcriptError).toBe('主进程没响应')
    expect(calls.removeSession).toHaveBeenCalledWith('chat-1')
  })

  /**
   * 留着的标签页会把会话复活：URL 上还带着 `?sid=`，一点开就 ensureSession
   * 出一条同名空会话，看起来像删除没生效。
   */
  it('顺带关掉这条会话开出来的标签页', async () => {
    const { deps, calls } = makeDeps({
      listTabs: () => [
        { key: 'a', path: '/dev-assistant?sid=chat-1' },
        { key: 'b', path: '/dev-assistant/chat?sid=chat-2' },
        { key: 'c', path: '/asset-management' }
      ]
    })

    const result = await deleteChatSession(deps)

    expect(calls.closeTab).toHaveBeenCalledTimes(1)
    expect(calls.closeTab).toHaveBeenCalledWith('a')
    expect(result.closedTabs).toBe(1)
  })

  it('空 sessionId 什么都不做', async () => {
    const { deps, calls } = makeDeps({ sessionId: '' })

    await deleteChatSession(deps)

    expect(calls.deleteTranscript).not.toHaveBeenCalled()
    expect(calls.removeSession).not.toHaveBeenCalled()
  })
})

describe('deleteChatSessions', () => {
  function makeBatchDeps(overrides: Partial<DeleteChatSessionsDeps> = {}): {
    deps: DeleteChatSessionsDeps
    calls: {
      deleteTranscript: ReturnType<typeof vi.fn>
      dropSessions: ReturnType<typeof vi.fn>
      removeSessions: ReturnType<typeof vi.fn>
      closeTab: ReturnType<typeof vi.fn>
    }
  } {
    const calls = {
      deleteTranscript: vi.fn(async () => ({ success: true })),
      dropSessions: vi.fn(),
      removeSessions: vi.fn(),
      closeTab: vi.fn()
    }

    return {
      calls,
      deps: {
        targets: [
          { sessionId: 'chat-1', agentSessionId: 'agent-1' },
          { sessionId: 'chat-2', agentSessionId: 'agent-2' }
        ],
        deleteTranscript: calls.deleteTranscript,
        dropSessions: calls.dropSessions,
        removeSessions: calls.removeSessions,
        listTabs: (): ChatSessionTab[] => [],
        closeTab: calls.closeTab,
        ...overrides
      }
    }
  }

  /**
   * 性能契约：界面那几处必须各动一次。消息和会话两个 store 每次变更都会把
   * 整个库序列化进 localStorage，逐条删 N 条会话就是 N 次全量写盘，几百条
   * 会话能把主线程卡住一分钟 —— 这正是这条函数存在的原因。
   */
  it('每个 store 只变更一次，拿到的是全部会话 id', async () => {
    const { deps, calls } = makeBatchDeps()

    await deleteChatSessions(deps)

    expect(calls.dropSessions).toHaveBeenCalledTimes(1)
    expect(calls.dropSessions).toHaveBeenCalledWith(['chat-1', 'chat-2'])
    expect(calls.removeSessions).toHaveBeenCalledTimes(1)
    expect(calls.removeSessions).toHaveBeenCalledWith(['chat-1', 'chat-2'])
  })

  it('内核记忆逐条删，没跑过 Agent 的会话不碰盘', async () => {
    const { deps, calls } = makeBatchDeps({
      targets: [{ sessionId: 'chat-1', agentSessionId: 'agent-1' }, { sessionId: 'chat-2' }]
    })

    await deleteChatSessions(deps)

    expect(calls.deleteTranscript).toHaveBeenCalledTimes(1)
    expect(calls.deleteTranscript).toHaveBeenCalledWith('agent-1')
  })

  it('个别内核记忆删失败不挡住其余的，错误收进结果', async () => {
    const { deps, calls } = makeBatchDeps({
      deleteTranscript: async (agentSessionId: string) => {
        if (agentSessionId === 'agent-1') throw new Error('主进程没响应')
        return { success: true }
      }
    })

    const result = await deleteChatSessions(deps)

    expect(result.transcriptErrors).toEqual(['主进程没响应'])
    expect(calls.removeSessions).toHaveBeenCalledTimes(1)
  })

  it('把所有被删会话的遗留标签页一起关掉', async () => {
    const { deps, calls } = makeBatchDeps({
      listTabs: () => [
        { key: 'a', path: '/dev-assistant?sid=chat-1' },
        { key: 'b', path: '/dev-assistant/chat?sid=chat-2' },
        { key: 'c', path: '/dev-assistant?sid=chat-9' },
        { key: 'd', path: '/asset-management' }
      ]
    })

    const result = await deleteChatSessions(deps)

    expect(calls.closeTab).toHaveBeenCalledTimes(2)
    expect(calls.closeTab).toHaveBeenCalledWith('a')
    expect(calls.closeTab).toHaveBeenCalledWith('b')
    expect(result.closedTabs).toBe(2)
  })

  it('没有有效目标时什么都不做', async () => {
    const { deps, calls } = makeBatchDeps({ targets: [{ sessionId: '' }] })

    const result = await deleteChatSessions(deps)

    expect(result).toEqual({ transcriptErrors: [], closedTabs: 0 })
    expect(calls.deleteTranscript).not.toHaveBeenCalled()
    expect(calls.dropSessions).not.toHaveBeenCalled()
    expect(calls.removeSessions).not.toHaveBeenCalled()
  })

  it('先删完盘上的，再一次清界面', async () => {
    const order: string[] = []
    const { deps } = makeBatchDeps({
      deleteTranscript: async () => {
        order.push('transcript')
        return { success: true }
      },
      dropSessions: () => order.push('messages'),
      removeSessions: () => order.push('sessions')
    })

    await deleteChatSessions(deps)

    // 两条内核记忆都删完之后，界面才动一次
    expect(order).toEqual(['transcript', 'transcript', 'messages', 'sessions'])
  })
})

describe('isSessionTab', () => {
  it.each([
    ['/dev-assistant?sid=chat-1', true],
    ['/dev-assistant/chat?sid=chat-1', true],
    ['/dev-assistant?sid=chat-1&project=Demo', true],
    ['/dev-assistant?sid=chat-10', false],
    ['/dev-assistant', false],
    ['/asset-management?sid=chat-1', false]
  ])('%s → %s', (path, expected) => {
    expect(isSessionTab(path, 'chat-1')).toBe(expected)
  })

  it('会话 id 为空时不匹配任何标签页', () => {
    expect(isSessionTab('/dev-assistant?sid=', '')).toBe(false)
  })
})
