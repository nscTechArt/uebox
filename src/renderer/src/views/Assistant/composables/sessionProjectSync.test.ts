import { describe, expect, it, vi } from 'vitest'

import { applySessionProjectEvent } from './sessionProjectSync'

/** 内核 id → 界面 id 的那一步在 store 里，这里照着真实映射打一份桩 */
function makeStore(
  agentSessionId = 'agent-1',
  id = 'chat-1'
): {
  sessionByAgentSessionId: ReturnType<typeof vi.fn>
  setProject: ReturnType<typeof vi.fn>
  clearProject: ReturnType<typeof vi.fn>
} {
  return {
    sessionByAgentSessionId: vi.fn((wanted: string) => (wanted === agentSessionId ? { id } : null)),
    setProject: vi.fn(),
    clearProject: vi.fn()
  }
}

/**
 * 模型改了会话归属，界面得跟着变 —— 而这一层唯一会出错的地方就是
 * 「`null` 该走 clearProject 还是 setProject」。
 *
 * 走错了不会报任何错：`setProject(id, null)` 会被 store 的去重当成「和现在一样」
 * 悄悄吃掉，于是用户明说「这条不归任何工程」之后，下一条消息又被自动塞回去
 * （首条消息的自动归属靠 `undefined` 和 `null` 的区别决定要不要盖戳，
 * 见 store 里 `clearProject` 的注释）。
 */
describe('applySessionProjectEvent', () => {
  /**
   * 主进程报上来的是**内核** id，store 是按**界面** id 存的 —— 两个不同的 uuid。
   *
   * 直接拿内核 id 去 `setProject` 的话，store 查不到就静默 return：工具报告
   * 「侧边栏已经跟着变了」，界面纹丝不动，用户下一条消息再把旧归属传下来，
   * 改动被整个抹掉。这一条钉死那次翻译。
   */
  it('先把内核 id 翻成界面 id 再写 store', () => {
    const store = makeStore('agent-1', 'chat-1')
    applySessionProjectEvent(
      {
        sessionId: 'agent-1',
        project: { projectName: 'LotusPond', projectPath: 'I:/Dev/LotusPond' }
      },
      store
    )

    expect(store.sessionByAgentSessionId).toHaveBeenCalledWith('agent-1')
    expect(store.setProject).toHaveBeenCalledWith('chat-1', {
      projectName: 'LotusPond',
      projectPath: 'I:/Dev/LotusPond'
    })
    expect(store.clearProject).not.toHaveBeenCalled()
  })

  it('null 走 clearProject，不是 setProject(null)', () => {
    const store = makeStore('agent-1', 'chat-1')
    applySessionProjectEvent({ sessionId: 'agent-1', project: null }, store)

    expect(store.clearProject).toHaveBeenCalledWith('chat-1')
    expect(store.setProject).not.toHaveBeenCalled()
  })

  // 名字是空串等同「不归属」——不能拿它去 setProject，store 会直接 return，
  // 结果是这次改动一声不响地没生效
  it('工程名是空串时按解除归属处理', () => {
    const store = makeStore('agent-1', 'chat-1')
    applySessionProjectEvent({ sessionId: 'agent-1', project: { projectName: '  ' } }, store)

    expect(store.clearProject).toHaveBeenCalledWith('chat-1')
  })

  // 会话已删、或事件属于别的窗口：翻不出界面 id 就什么都别做
  it('翻不出界面会话时什么都不写', () => {
    const store = makeStore('agent-1', 'chat-1')
    applySessionProjectEvent({ sessionId: 'agent-somewhere-else', project: null }, store)

    expect(store.setProject).not.toHaveBeenCalled()
    expect(store.clearProject).not.toHaveBeenCalled()
  })

  it('没有 sessionId 的事件一律忽略，不去动任何一条会话', () => {
    const store = makeStore()
    applySessionProjectEvent(undefined, store)
    applySessionProjectEvent({ sessionId: '  ', project: null }, store)

    expect(store.sessionByAgentSessionId).not.toHaveBeenCalled()
    expect(store.setProject).not.toHaveBeenCalled()
    expect(store.clearProject).not.toHaveBeenCalled()
  })
})
