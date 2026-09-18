import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

import { NOTIFICATION_ACTIVATE_CHANNEL } from '@core/shared/agentNotificationActivation'

import { useNotificationActivation } from './notificationActivation'

/**
 * 点了通知要跳到**发通知的那条会话**。
 *
 * 只把窗口拉到前台的话，用户回来看到的是他离开时那个页面 —— 通知等于只帮他
 * 按了一下任务栏，他还得自己想起来是哪条对话、翻到它、点开。
 */

/** vue-router 的 NavigationFailureType，桩里照抄一份 */
const CANCELLED = 8
const DUPLICATED = 16

/** 一个「导航没成」的返回值。`push` 遇到这些是 resolve 而不是 reject */
function navigationFailure(type: number): void {
  return { type } as unknown as void
}

const push = vi.fn(() => Promise.resolve())
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  NavigationFailureType: { aborted: 4, cancelled: 8, duplicated: 16 },
  isNavigationFailure: (failure: unknown, type?: number) => {
    const actual = (failure as { type?: number } | null | undefined)?.type
    if (typeof actual !== 'number') return false
    return type === undefined || (actual & type) === type
  }
}))

const historyTabs: { path: string }[] = []
vi.mock('@renderer/store/modules/tabs', () => ({
  useTabsStore: () => ({ historyTabs })
}))

let sessionByAgentSessionId = vi.fn<(id: string) => { id: string } | null>(() => null)
vi.mock('@renderer/store/modules/chatSessions', () => ({
  useChatSessionsStore: () => ({
    sessionByAgentSessionId: (id: string) => sessionByAgentSessionId(id)
  })
}))

const focusApproval = vi.fn()
vi.mock('@renderer/store/modules/pendingApprovals', () => ({
  usePendingApprovalsStore: () => ({ focus: focusApproval })
}))

/** 主进程那条「用户点了通知」的消息 */
let fireActivate: (payload?: {
  notificationKey?: string
  sessionId?: string
  toolCallId?: string
}) => void = () => {}
const off = vi.fn()
/** 存着的那条激活，`takePending` 取走即清 */
let pendingPayload: { notificationKey: string; sessionId: string; toolCallId?: string } | null =
  null
/** 界面回给主进程的那句「认没认出来」 */
const reported: { notificationKey: string; handled: boolean }[] = []
/** 让两条 IPC 都失败，验证失败都被咽掉 */
let invokeRejects = false

/**
 * `on` 注册的是**包装过**的 listener 并把它返回 —— preload 就是这么做的
 * （`const handler = (_, ...args) => listener(...args)`）。桩必须照做：
 * 返回原样的话，「退订时传错了函数」这个 bug 在用例里根本不成立。
 */
function fakeOn(
  channel: string,
  listener: (...args: unknown[]) => void
): (...args: unknown[]) => void {
  const wrapped = (...args: unknown[]): void => listener(args[0])
  if (channel === NOTIFICATION_ACTIVATE_CHANNEL) {
    fireActivate = wrapped as typeof fireActivate
  }
  return wrapped
}

function mountHost(): ReturnType<typeof mount> {
  const Host = defineComponent({
    setup() {
      useNotificationActivation()
      return () => h('div')
    }
  })
  return mount(Host)
}

describe('点系统通知跳回会话', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    push.mockClear()
    off.mockClear()
    focusApproval.mockClear()
    historyTabs.length = 0
    sessionByAgentSessionId = vi.fn(() => null)
    fireActivate = () => {}
    pendingPayload = null
    reported.length = 0
    invokeRejects = false
    // @ts-expect-error 测试环境里没有 preload 注入的 window.api
    window.api = {
      on: fakeOn,
      off,
      agentNotifications: {
        takePending: vi.fn(() => {
          if (invokeRejects) return Promise.reject(new Error('No handler registered'))
          const taken = pendingPayload
          pendingPayload = null
          return Promise.resolve(taken)
        }),
        reportActivation: vi.fn((result: { notificationKey: string; handled: boolean }) => {
          if (invokeRejects) return Promise.reject(new Error('No handler registered'))
          reported.push(result)
          return Promise.resolve()
        })
      }
    }
  })

  it('按内核会话 id 反查界面那条，再跳过去', () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))

    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })

    expect(sessionByAgentSessionId).toHaveBeenCalledWith('agent-session-7')
    expect(push).toHaveBeenCalledWith({ name: 'AssistantWelcome', query: { sid: 'chat-7' } })
  })

  it('这条会话已经有标签页开着就复用它，不再开一个', () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))
    historyTabs.push({ path: '/home' }, { path: '/dev-assistant?sid=chat-7' })

    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })

    expect(push).toHaveBeenCalledWith('/dev-assistant?sid=chat-7')
  })

  it('反查不到就什么都不做 —— 窗口已经在前台了，再硬跳一个猜的会话更糟', () => {
    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-unknown' })

    expect(push).not.toHaveBeenCalled()
  })

  it('带审批号时把那一条顶到确认框最前面 —— 队首可能是别条会话的', () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))

    mountHost()
    fireActivate({
      notificationKey: 'turn:agent-session-7',
      sessionId: 'agent-session-7',
      toolCallId: 'call-9'
    })

    expect(focusApproval).toHaveBeenCalledWith('call-9')
  })

  it('笔记本里的对话回笔记本，不拽成一个光秃秃的助手标签页', () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'notebook-chat-42' }))

    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-nb' })

    expect(push).toHaveBeenCalledWith({ name: 'NotebookDetail', params: { id: '42' } })
  })

  it('推送落空时，挂上来主动取回主进程存着的那条', async () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))
    pendingPayload = { notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' }

    mountHost()
    await nextTick()
    await nextTick()

    expect(push).toHaveBeenCalledWith({ name: 'AssistantWelcome', query: { sid: 'chat-7' } })
  })

  /*
   * 主进程只知道窗口拉起来了。认不认得这条会话只有界面知道 —— 认不出来它要
   * 把通知重新弹一条，不回话的话用户手上就什么都没有了。
   */
  it('真跳到了才回 handled', async () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))

    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })
    // 跳转还没落地，这会儿谎报的话主进程就把通知收了
    expect(reported).toHaveLength(0)

    await nextTick()
    await nextTick()
    expect(reported).toContainEqual({ notificationKey: 'turn:agent-session-7', handled: true })
  })

  /*
   * `push` 只在守卫抛错、chunk 拉不下来时才 reject。被中止（`next(false)`）和
   * 被后来的导航顶掉都是正常 resolve 的，只带回一个 NavigationFailure ——
   * 不看返回值就会谎报「跳到了」，主进程照此把通知收掉，而用户在别处。
   */
  it('导航被顶掉要回 handled: false', async () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))
    push.mockImplementationOnce(() => Promise.resolve(navigationFailure(CANCELLED)))

    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })
    await nextTick()
    await nextTick()

    expect(reported).toContainEqual({ notificationKey: 'turn:agent-session-7', handled: false })
  })

  // 「已经在这条路由上」也是一种 failure，但他要看的东西就在眼前，算跳到了
  it('重复导航算跳到了', async () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))
    push.mockImplementationOnce(() => Promise.resolve(navigationFailure(DUPLICATED)))

    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })
    await nextTick()
    await nextTick()

    expect(reported).toContainEqual({ notificationKey: 'turn:agent-session-7', handled: true })
  })

  // 跳到一半失败了（守卫抛错、chunk 拉不下来）要如实说没成，主进程好把通知重弹
  it('跳转失败要回 handled: false', async () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))
    push.mockImplementationOnce(() => Promise.reject(new Error('chunk 404')))

    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })
    await nextTick()
    await nextTick()

    expect(reported).toContainEqual({ notificationKey: 'turn:agent-session-7', handled: false })
  })

  it('没认出来也要回话，而且是 handled: false', () => {
    mountHost()
    fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-unknown' })

    expect(reported).toContainEqual({ notificationKey: 'turn:agent-session-7', handled: false })
  })

  // 这两条 IPC 都可能因为处理器还没挂上而 reject。咽掉，别变成没人管的 rejection
  it('IPC 失败不往外抛', async () => {
    sessionByAgentSessionId = vi.fn(() => ({ id: 'chat-7' }))
    invokeRejects = true

    mountHost()
    expect(() =>
      fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })
    ).not.toThrow()
    await nextTick()
    await nextTick()

    // 取回失败也只是没有补跳，不影响推送那一条
    expect(push).toHaveBeenCalled()
  })

  it('卸载时退订 —— 退的必须是 on() 返回的那个包装，传原始 listener 等于没退', () => {
    const host = mountHost()
    const attached = fireActivate
    host.unmount()

    expect(off).toHaveBeenCalledWith(NOTIFICATION_ACTIVATE_CHANNEL, attached)
  })
})
