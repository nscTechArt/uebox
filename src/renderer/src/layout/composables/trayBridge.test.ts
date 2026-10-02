import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'

import { TRAY_ACTION_CHANNEL, type TrayAction } from '@core/shared/trayActions'

import { useTrayBridge } from './trayBridge'

/**
 * 托盘菜单和界面之间的桥：
 * - 最近活跃的三条对话报给主进程（变了才报）
 * - 菜单点了什么回来：跳到那条会话 / 开新对话 / 弹插件没装上的对话框
 * - 动作本体只有 take-pending 一条路：收到提醒去取、挂载也取一次，取走即清
 */

const push = vi.fn<(arg: unknown) => Promise<void>>(() => Promise.resolve())
vi.mock('vue-router', () => ({
  useRouter: () => ({ push })
}))

const historyTabs: { path: string }[] = []
vi.mock('@renderer/store/modules/tabs', () => ({
  useTabsStore: () => ({ historyTabs })
}))

interface SessionLike {
  id: string
  title: string
  updatedAt: number
  pinned?: boolean
  project?: { projectName: string }
}

/*
 * 上报的数据源是 store 的 `displayableSessions` —— store 已按 updatedAt
 * 排好序（替身照真 store 的契约排），托盘只切前三，不跟侧边栏的分组
 * 渲染序（置顶、工程分组、sortMode 都不该影响它）。
 */
const sessions = ref<SessionLike[]>([])
vi.mock('@renderer/store/modules/chatSessions', () => ({
  useChatSessionsStore: () => ({
    get displayableSessions() {
      return [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    sessionById: (id: string) => sessions.value.find((session) => session.id === id) ?? null
  })
}))

const notifyPluginInstallFailure = vi.fn()
vi.mock('@renderer/hooks/usePluginInstallNotice', () => ({
  notifyPluginInstallFailure: (payload: unknown) => notifyPluginInstallFailure(payload)
}))

/** 主进程那句「托盘有动作，来取」的提醒（不带负载） */
let firePoke: () => void = () => {}
const off = vi.fn()
const setRecentSessions = vi.fn(() => Promise.resolve({ success: true }))
let pendingAction: TrayAction | null = null
// 照抄主进程语义：取走即清
const takePending = vi.fn(() => {
  const taken = pendingAction
  pendingAction = null
  return Promise.resolve(taken)
})

/** 和 notificationActivation 同一个道理：on() 返回的是包装后的 handler */
function fakeOn(
  channel: string,
  listener: (...args: unknown[]) => void
): (...args: unknown[]) => void {
  const wrapped = (...args: unknown[]): void => listener(...args)
  if (channel === TRAY_ACTION_CHANNEL) {
    firePoke = wrapped
  }
  return wrapped
}

/*
 * 上一个用例挂着的宿主不卸的话，它的 watcher 还活着 —— sessions 一动，
 * 所有历史宿主都会跟着报一遍 setRecentSessions，用例之间就串了。
 */
const hosts: Array<ReturnType<typeof mount>> = []

function mountHost(): ReturnType<typeof mount> {
  const Host = defineComponent({
    setup() {
      useTrayBridge()
      return () => h('div')
    }
  })
  const host = mount(Host)
  hosts.push(host)
  return host
}

const session = (id: string, updatedAt = 1, extra: Partial<SessionLike> = {}): SessionLike => ({
  id,
  title: `标题-${id}`,
  updatedAt,
  ...extra
})

describe('托盘桥', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    push.mockClear()
    off.mockClear()
    setRecentSessions.mockClear()
    takePending.mockClear()
    notifyPluginInstallFailure.mockClear()
    historyTabs.length = 0
    sessions.value = []
    pendingAction = null
    firePoke = () => {}
    // @ts-expect-error 测试环境里没有 preload 注入的 window.api
    window.api = {
      on: fakeOn,
      off,
      tray: { setRecentSessions, takePending }
    }
  })

  afterEach(() => {
    while (hosts.length > 0) hosts.pop()?.unmount()
  })

  it('挂载就把最近活跃的前三条报给主进程', async () => {
    sessions.value = [session('s1', 1), session('s3', 3), session('s2', 2), session('s4', 0)]

    mountHost()
    await nextTick()

    // 按 updatedAt 取前三，跟 store 里摆的顺序无关
    expect(setRecentSessions).toHaveBeenCalledWith([
      { id: 's3', title: '标题-s3' },
      { id: 's2', title: '标题-s2' },
      { id: 's1', title: '标题-s1' }
    ])
  })

  it('纯会话比工程里的会话新时排在前面', async () => {
    // 默认按工程分组的侧边栏里纯会话排最后 —— 托盘不按那个序
    sessions.value = [
      session('a1', 5, { project: { projectName: 'A' } }),
      session('a2', 4, { project: { projectName: 'A' } }),
      session('a3', 3, { project: { projectName: 'A' } }),
      session('plain', 9)
    ]

    mountHost()
    await nextTick()

    expect(setRecentSessions).toHaveBeenCalledWith([
      { id: 'plain', title: '标题-plain' },
      { id: 'a1', title: '标题-a1' },
      { id: 'a2', title: '标题-a2' }
    ])
  })

  it('置顶但很久没动的会话不占位置', async () => {
    // 置顶是侧边栏的整理手段，不算「最近」
    sessions.value = [
      session('old', 1, { pinned: true }),
      session('n1', 5),
      session('n2', 4),
      session('n3', 3)
    ]

    mountHost()
    await nextTick()

    expect(setRecentSessions).toHaveBeenCalledWith([
      { id: 'n1', title: '标题-n1' },
      { id: 'n2', title: '标题-n2' },
      { id: 'n3', title: '标题-n3' }
    ])
  })

  it('列表变了重报，序列化没变不重报', async () => {
    sessions.value = [session('s1', 1), session('s2', 2), session('s3', 3)]
    mountHost()
    await nextTick()
    expect(setRecentSessions).toHaveBeenCalledTimes(1)

    // 第四名以后的变化不影响前三：序列化没变就不该再发
    sessions.value = [session('s1', 1), session('s2', 2), session('s3', 3), session('late', 0)]
    await nextTick()
    expect(setRecentSessions).toHaveBeenCalledTimes(1)

    sessions.value = [
      session('s4', 4),
      session('s1', 1),
      session('s2', 2),
      session('s3', 3),
      session('late', 0)
    ]
    await nextTick()
    expect(setRecentSessions).toHaveBeenCalledTimes(2)
    expect(setRecentSessions).toHaveBeenLastCalledWith([
      { id: 's4', title: '标题-s4' },
      { id: 's3', title: '标题-s3' },
      { id: 's2', title: '标题-s2' }
    ])
  })

  it('open-session：会话在就跳过去', async () => {
    sessions.value = [session('chat-7')]

    mountHost()
    pendingAction = { type: 'open-session', sessionId: 'chat-7' }
    firePoke()
    await nextTick()
    await nextTick()

    expect(push).toHaveBeenCalledWith({
      name: 'AssistantWelcome',
      query: { sid: 'chat-7' }
    })
  })

  it('open-session：这条会话的标签页开着就复用它', async () => {
    sessions.value = [session('chat-7')]
    historyTabs.push({ path: '/home' }, { path: '/dev-assistant?sid=chat-7' })

    mountHost()
    pendingAction = { type: 'open-session', sessionId: 'chat-7' }
    firePoke()
    await nextTick()
    await nextTick()

    expect(push).toHaveBeenCalledWith('/dev-assistant?sid=chat-7')
  })

  it('open-session：认不出这条会话就什么都不做', async () => {
    mountHost()
    pendingAction = { type: 'open-session', sessionId: 'nope' }
    firePoke()
    await nextTick()
    await nextTick()

    expect(push).not.toHaveBeenCalled()
  })

  it('new-session：跳到欢迎页并带一个新 sid', async () => {
    mountHost()
    pendingAction = { type: 'new-session' }
    firePoke()
    await nextTick()
    await nextTick()

    expect(push).toHaveBeenCalledTimes(1)
    const arg = push.mock.calls[0][0] as { name: string; query: { sid: string } }
    expect(arg.name).toBe('AssistantWelcome')
    expect(arg.query.sid).toMatch(/^[a-z0-9]+$/)
    expect(arg.query.sid.length).toBeGreaterThan(8)
  })

  it('plugin-failure：原样交给首页那张插件失败对话框', async () => {
    mountHost()
    pendingAction = {
      type: 'plugin-failure',
      pluginFailure: 'UPROJECT_UNREADABLE',
      originPath: 'D:/Demo/Demo.uproject',
      projectName: 'Demo'
    }
    firePoke()
    await nextTick()
    await nextTick()

    expect(notifyPluginInstallFailure).toHaveBeenCalledWith({
      pluginFailure: 'UPROJECT_UNREADABLE',
      data: { originPath: 'D:/Demo/Demo.uproject', projectName: 'Demo' }
    })
  })

  it('推送落空的那条挂载时取回来处理', async () => {
    sessions.value = [session('chat-7')]
    pendingAction = { type: 'open-session', sessionId: 'chat-7' }

    mountHost()
    await nextTick()
    await nextTick()

    expect(takePending).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith({
      name: 'AssistantWelcome',
      query: { sid: 'chat-7' }
    })
  })

  it('收到提醒就去取并处理 —— 提醒不带负载，动作本体在槽里', async () => {
    sessions.value = [session('chat-7')]
    mountHost()
    await nextTick()
    takePending.mockClear()

    pendingAction = { type: 'open-session', sessionId: 'chat-7' }
    firePoke()
    await nextTick()
    await nextTick()

    // 取的是槽里那条，提醒本身什么都没带
    expect(takePending.mock.lastCall).toEqual([])
    expect(push).toHaveBeenCalledWith({
      name: 'AssistantWelcome',
      query: { sid: 'chat-7' }
    })
  })

  /*
   * 挂载补取和提醒各会取一次：取走即清挡的就是「同一条执行两遍」——
   * 第二次取到的是 null。
   */
  it('挂载补取和提醒各取一次，只执行一次', async () => {
    sessions.value = [session('chat-7')]
    pendingAction = { type: 'open-session', sessionId: 'chat-7' }

    mountHost()
    await nextTick()
    await nextTick()

    // 挂载补取已经把它取走执行了；提醒再到时槽已空
    firePoke()
    await nextTick()
    await nextTick()

    const sidCalls = push.mock.calls.filter(
      (call) => (call[0] as { query?: { sid?: string } }).query?.sid === 'chat-7'
    )
    expect(sidCalls).toHaveLength(1)
    expect(pendingAction).toBeNull()
  })

  it('卸载时退订 —— 退的是 on() 返回的那个包装', () => {
    const host = mountHost()
    const attached = firePoke
    host.unmount()

    expect(off).toHaveBeenCalledWith(TRAY_ACTION_CHANNEL, attached)
  })
})
