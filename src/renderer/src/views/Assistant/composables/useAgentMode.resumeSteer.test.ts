import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'

import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useAgentMode } from './useAgentMode'

/**
 * 续跑 / 插话被拒时界面该说什么。
 *
 * `message` 整个桩掉（和 useAgentMode 看到的是同一个模块实例）：
 * 断言的是「选了哪种提示、说的哪句话」，不是 antd 怎么画。
 */
const messageCalls = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn()
}))

vi.mock('@renderer/utils/messageManager', () => ({ message: messageCalls }))

const agentV3 = vi.hoisted(() => ({
  continue: vi.fn(),
  steer: vi.fn()
}))

function mountAgentMode(): {
  api: ReturnType<typeof useAgentMode>
  chatMsgStore: {
    replaceTyping: ReturnType<typeof vi.fn>
    getMessages: ReturnType<typeof vi.fn>
    pushUser: ReturnType<typeof vi.fn>
  }
  pushAssistantTyping: ReturnType<typeof vi.fn>
} {
  const sid = ref('chat-1')
  const chatMsgStore = {
    replaceTyping: vi.fn(),
    getMessages: vi.fn(() => []),
    pushUser: vi.fn()
  }
  const chatStore = {
    getModel: vi.fn(() => undefined),
    getProject: vi.fn(() => undefined),
    getAgentSessionId: vi.fn(() => 'agent-1')
  }
  const pushAssistantTyping = vi.fn(() => 'typing-1')
  let api!: ReturnType<typeof useAgentMode>
  const Host = defineComponent({
    setup() {
      api = useAgentMode({
        sid,
        messages: computed(() => []),
        chatStore,
        chatMsgStore,
        tabsStore: {},
        route: { path: '/', query: {} },
        scrollToBottomIfNeeded: vi.fn(),
        pushUser: vi.fn(),
        pushAssistantTyping,
        currentAgentProcess: ref([])
      })
      return () => h('div')
    }
  })
  mount(Host)
  return { api, chatMsgStore, pushAssistantTyping }
}

beforeEach(() => {
  window.api.agentV3 = agentV3 as unknown as typeof window.api.agentV3
  agentV3.continue.mockReset()
  agentV3.steer.mockReset()
})

describe('resumeAgent 的忙闸', () => {
  it('拦不住、主进程回 SESSION_BUSY：气泡和 toast 都是本地化文案，不带会话号', async () => {
    const { api, chatMsgStore } = mountAgentMode()
    agentV3.continue.mockResolvedValue({
      success: false,
      code: 'SESSION_BUSY',
      error: '会话 agent-secret-id 正在执行中'
    })

    await api.resumeAgent('agent-secret-id')

    const sessionBusy = '这条对话还有一轮在跑'
    const bubbleCall = chatMsgStore.replaceTyping.mock.calls.at(-1)
    expect(String(bubbleCall?.[2])).toContain(sessionBusy)
    expect(String(bubbleCall?.[2])).not.toContain('agent-secret-id')
    expect(messageCalls.warning).toHaveBeenCalledWith(expect.stringContaining(sessionBusy))
    expect(String(messageCalls.warning.mock.calls.at(-1)?.[0])).not.toContain('agent-secret-id')
  })

  it('起不来的摊子照收：不带码的失败退回原文', async () => {
    const { api, chatMsgStore } = mountAgentMode()
    agentV3.continue.mockResolvedValue({ success: false, error: '磁盘写满了' })

    await api.resumeAgent('agent-x')

    const bubbleText = String(chatMsgStore.replaceTyping.mock.calls.at(-1)?.[2])
    expect(bubbleText).toContain('磁盘写满了')
    // 「等释放」标记得摘，不摘这条对话永远显示忙
    expect(useAgentStreamStore().isBusy('chat-1')).toBe(false)
  })
})

describe('steerAgent 的被拒文案', () => {
  it('这一轮已结束 + 放回输入框（默认）：info，说内容放回去了', async () => {
    const { api } = mountAgentMode()
    agentV3.steer.mockResolvedValue({ success: false, code: 'NOT_RUNNING' })

    const sent = await api.steerAgent('加一句', { targetSessionId: 'agent-1' })

    expect(sent).toBe(false)
    expect(messageCalls.info).toHaveBeenCalledWith(expect.stringContaining('放回输入框'))
    expect(messageCalls.warning).not.toHaveBeenCalled()
  })

  it('这一轮已结束 + 留在队列：info，说会按排队顺序发出', async () => {
    const { api } = mountAgentMode()
    agentV3.steer.mockResolvedValue({ success: false, code: 'NOT_RUNNING' })

    const sent = await api.steerAgent('加一句', {
      targetSessionId: 'agent-1',
      ifRejected: 'queued'
    })

    expect(sent).toBe(false)
    expect(messageCalls.info).toHaveBeenCalledWith(expect.stringContaining('排队顺序'))
    expect(messageCalls.warning).not.toHaveBeenCalled()
  })

  it('工程对不上 + 放回输入框：两个工程名拼进去', async () => {
    const { api } = mountAgentMode()
    agentV3.steer.mockResolvedValue({
      success: false,
      code: 'PROJECT_MISMATCH',
      error: '这条插话是在「GameA」上抓的……',
      errorParams: { snapshotProject: 'GameA', runProject: 'GameB' }
    })

    const sent = await api.steerAgent('加一句', { targetSessionId: 'agent-1' })

    expect(sent).toBe(false)
    const text = String(messageCalls.info.mock.calls.at(-1)?.[0])
    expect(text).toContain('GameA')
    expect(text).toContain('GameB')
    expect(text).toContain('放回输入框')
  })

  it('工程对不上 + 留在队列：说会按原工程发出去', async () => {
    const { api } = mountAgentMode()
    agentV3.steer.mockResolvedValue({
      success: false,
      code: 'PROJECT_MISMATCH',
      errorParams: { snapshotProject: 'GameA', runProject: 'GameB' }
    })

    const sent = await api.steerAgent('加一句', {
      targetSessionId: 'agent-1',
      ifRejected: 'queued'
    })

    expect(sent).toBe(false)
    const text = String(messageCalls.info.mock.calls.at(-1)?.[0])
    expect(text).toContain('GameA')
    expect(text).toContain('GameB')
    expect(text).not.toContain('放回输入框')
  })

  it('工程名是空串：代入「另一个工程」，不摆空引号', async () => {
    const { api } = mountAgentMode()
    agentV3.steer.mockResolvedValue({
      success: false,
      code: 'PROJECT_MISMATCH',
      errorParams: { snapshotProject: '', runProject: '' }
    })

    await api.steerAgent('加一句', { targetSessionId: 'agent-1' })

    const text = String(messageCalls.info.mock.calls.at(-1)?.[0])
    expect(text).toContain('另一个工程')
    expect(text).not.toContain('「」')
  })

  it('其他拒绝照旧走「插话失败」外框（warning，不是 info）', async () => {
    const { api } = mountAgentMode()
    agentV3.steer.mockResolvedValue({ success: false, error: '内核拒了' })

    const sent = await api.steerAgent('加一句', { targetSessionId: 'agent-1' })

    expect(sent).toBe(false)
    expect(messageCalls.warning).toHaveBeenCalledWith(expect.stringContaining('插话失败'))
    expect(messageCalls.warning).toHaveBeenCalledWith(expect.stringContaining('内核拒了'))
    expect(messageCalls.info).not.toHaveBeenCalled()
  })
})

describe('续跑文案不再有写死的中文', () => {
  it('useAgentMode 里没有「从断点继续执行」「续跑失败」字面量', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/views/Assistant/composables/useAgentMode.ts'),
      'utf8'
    )
    expect(source).not.toContain('从断点继续执行')
    // console.error 那行是日志不是界面文案，「续跑失败」留在日志里不算命中
    const copySource = source
      .split('\n')
      .filter((line) => !line.includes('console.'))
      .join('\n')
    expect(copySource).not.toContain('续跑失败')
  })
})
