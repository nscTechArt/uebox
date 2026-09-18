import { describe, expect, it, vi } from 'vitest'
import { reconcileTypingMessages, resolveReattachSeed, type ReconcileDeps } from './agentReattach'
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'

/**
 * 刷新页面后的裁决：谁还活着接回来，谁真死了才标中断。
 *
 * 这里守的是那个错误假设 —— agent 跑在主进程，刷新只重启了界面，
 * 「一律当作中断」有一半是假的，而假的那一半后台还在改用户的工程。
 */
function makeDeps(overrides: Partial<ReconcileDeps> = {}): {
  deps: ReconcileDeps
  interrupted: Array<[string, string]>
  reattached: string[]
} {
  const interrupted: Array<[string, string]> = []
  const reattached: string[] = []

  const deps: ReconcileDeps = {
    pending: [{ sid: 'chat-1', messageId: 'msg-1' }],
    agentSessionIdOf: (chatSid) => (chatSid === 'chat-1' ? 'agent-1' : ''),
    fetchRunning: async (ids) => ids,
    reattach: (session) => reattached.push(session.agentSessionId),
    markInterrupted: (chatSid, messageId) => interrupted.push([chatSid, messageId]),
    ...overrides
  }

  return { deps, interrupted, reattached }
}

describe('reconcileTypingMessages', () => {
  it('主进程说还在跑就接回来，不贴中断标记', async () => {
    const { deps, interrupted, reattached } = makeDeps()

    const result = await reconcileTypingMessages(deps)

    expect(reattached).toEqual(['agent-1'])
    expect(interrupted).toEqual([])
    expect(result.reattached).toEqual([
      { chatSid: 'chat-1', agentSessionId: 'agent-1', messageId: 'msg-1' }
    ])
  })

  it('主进程说不在跑才标中断', async () => {
    const { deps, interrupted, reattached } = makeDeps({ fetchRunning: async () => [] })

    await reconcileTypingMessages(deps)

    expect(reattached).toEqual([])
    expect(interrupted).toEqual([['chat-1', 'msg-1']])
  })

  it('问不到主进程时退回「全部中断」，不留下永远转圈的气泡', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, interrupted, reattached } = makeDeps({
      fetchRunning: async () => {
        throw new Error('IPC 挂了')
      }
    })

    await reconcileTypingMessages(deps)

    expect(reattached).toEqual([])
    expect(interrupted).toEqual([['chat-1', 'msg-1']])
    warn.mockRestore()
  })

  it('对话没有 agent 会话号就不问主进程，直接标中断', async () => {
    const fetchRunning = vi.fn(async () => [])
    const { deps, interrupted } = makeDeps({
      agentSessionIdOf: () => '',
      fetchRunning
    })

    await reconcileTypingMessages(deps)

    expect(fetchRunning).not.toHaveBeenCalled()
    expect(interrupted).toEqual([['chat-1', 'msg-1']])
  })

  it('同一对话里的旧 typing 一律标中断，只有最后一条可能被接回', async () => {
    const { deps, interrupted, reattached } = makeDeps({
      pending: [
        { sid: 'chat-1', messageId: 'msg-old' },
        { sid: 'chat-1', messageId: 'msg-1' }
      ]
    })

    await reconcileTypingMessages(deps)

    // 会话一次只跑一轮，前面那条是更早一次刷新留下的尸体
    expect(reattached).toEqual(['agent-1'])
    expect(interrupted).toEqual([['chat-1', 'msg-old']])
  })

  it('多个对话各自裁决，一条会话没跑不影响另一条接回来', async () => {
    const { deps, interrupted, reattached } = makeDeps({
      pending: [
        { sid: 'chat-1', messageId: 'msg-1' },
        { sid: 'chat-2', messageId: 'msg-2' }
      ],
      agentSessionIdOf: (chatSid) => (chatSid === 'chat-1' ? 'agent-1' : 'agent-2'),
      fetchRunning: async () => ['agent-2']
    })

    await reconcileTypingMessages(deps)

    expect(reattached).toEqual(['agent-2'])
    expect(interrupted).toEqual([['chat-1', 'msg-1']])
  })

  it('没有残留的 typing 消息时一次 IPC 都不发', async () => {
    const fetchRunning = vi.fn(async () => [])
    const { deps } = makeDeps({ pending: [], fetchRunning })

    const result = await reconcileTypingMessages(deps)

    expect(fetchRunning).not.toHaveBeenCalled()
    expect(result).toEqual({ reattached: [], interrupted: [] })
  })
})

/**
 * 接回来时从哪儿续写。
 *
 * 这里守的是那条重影 bug：占位符被当成模型说过的话带进 `currentText` 之后，
 * 刷新后的正文接在它后面继续累积，`content` 因此比过程时间线多出一个前缀，
 * 界面在时间线下面把整条回复又画了一遍。
 */
describe('resolveReattachSeed', () => {
  it('刷新前写了一半就带着那半截续写', () => {
    expect(resolveReattachSeed({ content: '刷新前说了一半' })).toBe('刷新前说了一半')
  })

  it.each([
    ['store 初始占位符', '正在思考...'],
    ['agent 那条路写进去的中文占位符', zhCN.assistant.agentProcess.thinking],
    ['同一句的英文写法', enUS.assistant.agentProcess.thinking]
  ])('占位符一个字都不带进正文（%s）', (_label, placeholder) => {
    expect(resolveReattachSeed({ content: placeholder })).toBe('')
  })

  it('多模态内容和取不到消息时都从空开始', () => {
    expect(resolveReattachSeed({ content: [{ type: 'text', text: '图文混排' }] })).toBe('')
    expect(resolveReattachSeed(undefined)).toBe('')
  })
})
