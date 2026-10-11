import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'

import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useAgentMode } from './useAgentMode'

/**
 * 「接着跑」的忙闸看 `isBusy`，不看 `isStreaming`。
 *
 * 界面停了、主进程还没 `released` 的空档里点续跑，主进程会拒掉；被拒后的
 * `abandon()` 会把上一轮留下的「等释放」标记一起摘掉，排队的下一条就提前出队、
 * 被顶回来丢掉。所以这个空档里根本不该发出去。
 */
const messageCalls = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn()
}))

vi.mock('@renderer/utils/messageManager', () => ({ message: messageCalls }))

const agentV3 = vi.hoisted(() => ({ continue: vi.fn() }))

function mountAgentMode(): ReturnType<typeof useAgentMode> {
  let api!: ReturnType<typeof useAgentMode>
  const Host = defineComponent({
    setup() {
      api = useAgentMode({
        sid: ref('chat-1'),
        messages: computed(() => []),
        chatStore: {
          getModel: vi.fn(() => undefined),
          getProject: vi.fn(() => undefined),
          getAgentSessionId: vi.fn(() => 'agent-1')
        },
        chatMsgStore: { replaceTyping: vi.fn(), getMessages: vi.fn(() => []), pushUser: vi.fn() },
        tabsStore: {},
        route: { path: '/', query: {} },
        scrollToBottomIfNeeded: vi.fn(),
        pushUser: vi.fn(),
        pushAssistantTyping: vi.fn(() => 'typing-1'),
        currentAgentProcess: ref([])
      })
      return () => h('div')
    }
  })
  mount(Host)
  return api
}

beforeEach(() => {
  window.api.agentV3 = agentV3 as unknown as typeof window.api.agentV3
  agentV3.continue.mockReset()
})

describe('resumeAgent 的忙闸', () => {
  it('上一轮还没等到 released：不发续跑，也不摘「等释放」标记', async () => {
    const api = mountAgentMode()
    const stream = useAgentStreamStore()
    stream.markAwaitingRelease('chat-1', 'agent-1')

    await api.resumeAgent('agent-1')

    expect(agentV3.continue).not.toHaveBeenCalled()
    expect(stream.isBusy('chat-1')).toBe(true)
    expect(messageCalls.info).toHaveBeenCalledWith(expect.stringContaining('仍有一轮任务在运行'))
  })

  it('空出来了照常续跑', async () => {
    const api = mountAgentMode()
    agentV3.continue.mockResolvedValue({ success: true })

    await api.resumeAgent('agent-1')

    expect(agentV3.continue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'agent-1' }))
  })
})
