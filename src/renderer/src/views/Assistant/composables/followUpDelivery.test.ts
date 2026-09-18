import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

import { useFollowUpQueueStore } from '@renderer/store/modules/followUpQueue'
import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { __setAppAgentRunnerForTest } from './appAgentRunner'
import { enqueueFollowUp } from './followUpQueue'
import { useFollowUpDelivery } from './followUpDelivery'

/**
 * 排着的话要在**没有助手页挂着**的时候也发得出去。
 *
 * 这是这套东西存在的全部理由：助手路由没开 keepAlive，用户切去看素材库那一刻
 * 页面连同它的监听器一起没了，而这一轮照样在主进程里跑。跑完那条 `released`
 * 必须有人接 —— 接的人就是这里，它挂在常驻布局上，比任何页面都活得久。
 */

/**
 * 应用级运行器。用例里没有真的常驻布局可挂，直接塞一个。
 *
 * 桩要跟着做一件真实现做的事：**同步**把这条对话标成「忙」。
 * `useAgentMode.executeAgent` 在第一个 await 之前就 `markAwaitingRelease` 了，
 * 正是这一下挡住了「一轮还没起来、下一条就被投出去」。桩里少了它，测出来的
 * 「发了两次」是桩的性质，不是代码的。
 */
const executeAgent = vi.fn((_message: unknown, _excel: unknown, options?: { chatSid?: string }) => {
  const chatSid = options?.chatSid
  if (chatSid) {
    useAgentStreamStore().markAwaitingRelease(chatSid, `agent-session-for-${chatSid}`)
  }
  return Promise.resolve(undefined)
})

/*
 * 把 `useAgentMode` 挡掉。这里测的是「什么时候该发下一条」，不是 agent 怎么跑；
 * 真加载它会把 api/ai → i18n 那整条链拖进来，和下面 vue-i18n 的桩撞车。
 */
vi.mock('./useAgentMode', () => ({
  useAgentMode: () => ({ executeAgent })
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/asset', fullPath: '/asset', query: {}, name: 'Asset', params: {} })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/store/modules/tabs', () => ({
  useTabsStore: () => ({ updateTabTitleByPath: vi.fn() })
}))

const chatSessionsStore = {
  ensureSession: vi.fn(),
  sessionById: vi.fn(() => null),
  updateTitle: vi.fn(),
  appendMessage: vi.fn(),
  setProject: vi.fn()
}

vi.mock('@renderer/store/modules/chatSessions', () => ({
  useChatSessionsStore: () => chatSessionsStore
}))

/** 主进程那条「会话空出来了」的广播 */
let fireReleased: (payload?: { sessionId?: string }) => void = () => {}

function mountHost(): ReturnType<typeof mount> {
  const Host = defineComponent({
    setup() {
      useFollowUpDelivery()
      return () => h('div')
    }
  })
  return mount(Host)
}

describe('后台投递排着的跟进消息', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    executeAgent.mockClear()
    __setAppAgentRunnerForTest(executeAgent)
    Object.values(chatSessionsStore).forEach((fn) => fn.mockClear?.())
    // @ts-expect-error 测试环境里没有 preload 注入的 window.api
    window.api = {
      on: (channel: string, handler: () => void) => {
        if (channel === 'agent-v3:released') fireReleased = handler as typeof fireReleased
        return () => {}
      },
      off: vi.fn()
    }
  })

  it('会话空出来就把队首那条发出去 —— 一个助手页都没挂着', async () => {
    const queue = useFollowUpQueueStore()
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '顺便把材质也调一下', {
      content: '顺便把材质也调一下'
    }).queues

    mountHost()
    fireReleased()

    expect(executeAgent).toHaveBeenCalledWith('顺便把材质也调一下', undefined, {
      chatSid: 'chat-1'
    })
    // 队列里那条要摘掉，否则下一次 released 会把同一句话再发一遍
    expect(queue.queues['chat-1']).toBeUndefined()
  })

  it('用户气泡写进目标对话，不是用户此刻正看着的那条', () => {
    const queue = useFollowUpQueueStore()
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '继续', { content: '继续' }).queues

    mountHost()
    fireReleased()

    expect(useChatMessagesStore().getMessages('chat-1').at(-1)?.content).toBe('继续')
  })

  it('这条对话自己还在跑就不发 —— 发了会被主进程顶回来', () => {
    const queue = useFollowUpQueueStore()
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '继续', { content: '继续' }).queues
    useAgentStreamStore().initStream('chat-1', 'agent-session-1', 'typing-1')

    mountHost()
    fireReleased()

    expect(executeAgent).not.toHaveBeenCalled()
    // 没发就得留在队列里，不能吞掉
    expect(queue.queues['chat-1']).toHaveLength(1)
  })

  it('一次只发一条，第二条等下一次 released', () => {
    const queue = useFollowUpQueueStore()
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '甲', { content: '甲' }).queues
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '乙', { content: '乙' }).queues

    mountHost()
    fireReleased()

    expect(executeAgent).toHaveBeenCalledTimes(1)
    expect(queue.queues['chat-1']).toHaveLength(1)
  })

  it('别条对话排着的也一起看 —— released 不带对话号', () => {
    const queue = useFollowUpQueueStore()
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '甲', { content: '甲' }).queues
    queue.queues = enqueueFollowUp(queue.queues, 'chat-2', '乙', { content: '乙' }).queues

    mountHost()
    fireReleased()

    expect(executeAgent).toHaveBeenCalledTimes(2)
  })

  /**
   * 「界面停了」不等于「后台空出来了」。
   *
   * 主进程的收尾顺序是：发 `done`（事件流最后一条）→ `prompt()` 返回 →
   * 摘登记表 → 发 `released`。渲染层收到 `done` 就把流式标志清了，但这个间隙里
   * 发出去仍然会被顶回来一句「会话正在执行中」—— 而投递是**先出队再发**的，
   * 被顶回来的那条话就此消失，用户什么都不会看到。
   */
  it('done 之后、released 之前不投递 —— 那会儿后台还没放', () => {
    const queue = useFollowUpQueueStore()
    const stream = useAgentStreamStore()
    stream.initStream('chat-1', 'agent-session-1', 'typing-1')
    stream.markAwaitingRelease('chat-1', 'agent-session-1')
    // 界面收到 done：流式标志清了，但后台还没说 released
    stream.endStream('agent-session-1')

    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '接着来', { content: '接着来' }).queues
    mountHost()

    expect(executeAgent).not.toHaveBeenCalled()
    expect(queue.queues['chat-1']).toHaveLength(1)
  })

  it('released 到了先摘「等释放」标记再投递，同一个处理器里做', () => {
    const queue = useFollowUpQueueStore()
    const stream = useAgentStreamStore()
    stream.initStream('chat-1', 'agent-session-1', 'typing-1')
    stream.markAwaitingRelease('chat-1', 'agent-session-1')
    stream.endStream('agent-session-1')
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '接着来', { content: '接着来' }).queues

    mountHost()
    fireReleased({ sessionId: 'agent-session-1' })

    // 发出去了 = 那条陈旧的「等释放」标记确实在投递之前就被摘掉了；
    // 顺序反过来的话，投递会看到自己还「忙」，什么都不发，然后再也没人来接
    expect(executeAgent).toHaveBeenCalledTimes(1)

    // 此刻 busy 是**新**那一轮占的（桩跟真实现一样，发起时就标上了）。
    // 把新的这一份摘掉之后不该再剩下什么 —— 剩下就说明旧标记没清干净
    stream.clearAwaitingRelease('agent-session-for-chat-1')
    expect(stream.isBusy('chat-1')).toBe(false)
  })

  /**
   * 用户是在框选着 A 段的时候说的那句话。哪怕它在队列里等了十分钟、他早就改选了
   * B 段 —— 模型该看到的仍是 A 段。这就是闪存存在的全部理由，投递时**不许重抓**。
   *
   * 界面上看不出任何痕迹 —— 闪存是后台的潜规则，只进模型上下文。
   */
  it('投递用的是入队那一刻的快照，原样透传', () => {
    const queue = useFollowUpQueueStore()
    const snapshot = {
      capturedAt: '2026-09-07T14:21:33.000Z',
      project: { projectName: 'GameA', projectPath: 'D:/Games/GameA', connectionId: 'conn-a' },
      focus: { selectedNodes: [], selectedNodeCount: 0 }
    }
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '这个啥意思', {
      content: '这个啥意思',
      editorSnapshot: snapshot,
      sessionProject: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    }).queues

    mountHost()
    fireReleased()

    expect(executeAgent).toHaveBeenCalledWith('这个啥意思', undefined, {
      chatSid: 'chat-1',
      editorSnapshot: snapshot,
      sessionProject: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    })
  })

  /**
   * 排队之前要先 `await` 一次闪存抓取（最多 2 秒），而这两秒里那一轮可能刚好跑完 ——
   * `released` 已经发过了，它看到的是一个空队列；消息随后才入队，就再也没人接了。
   * 所以队列一有新条目也试一次。
   */
  it('对话空闲时新排进来的一条立刻投递，不用等下一次 released', async () => {
    const queue = useFollowUpQueueStore()
    mountHost()

    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '迟到的一条', {
      content: '迟到的一条'
    }).queues
    await nextTick()

    expect(executeAgent).toHaveBeenCalledTimes(1)
  })

  it('还在跑的时候新排进来的不会被这条保险提前发出去', async () => {
    const queue = useFollowUpQueueStore()
    useAgentStreamStore().initStream('chat-1', 'agent-session-1', 'typing-1')
    mountHost()

    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '排着', { content: '排着' }).queues
    await nextTick()

    expect(executeAgent).not.toHaveBeenCalled()
    expect(queue.queues['chat-1']).toHaveLength(1)
  })
})

/**
 * 刷新（Ctrl+R）之后：队列落了盘还在，但没有任何事件会再来触发投递 ——
 * `released` 早发过了，watch 只认变化。所以投递器起来时要自己试一次。
 */
describe('刷新之后接上排着的话', () => {
  it('起来时对话已经空着，就把排着的发出去', () => {
    const queue = useFollowUpQueueStore()
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '刷新前排的那句', {
      content: '刷新前排的那句'
    }).queues

    // 没有 released，也没有新的入队动作 —— 只是挂上投递器
    mountHost()

    expect(executeAgent).toHaveBeenCalledWith('刷新前排的那句', undefined, { chatSid: 'chat-1' })
    expect(queue.queues['chat-1']).toBeUndefined()
  })

  it('那一轮还在跑就先不发，等它 released', () => {
    const queue = useFollowUpQueueStore()
    queue.queues = enqueueFollowUp(queue.queues, 'chat-1', '刷新前排的那句', {
      content: '刷新前排的那句'
    }).queues
    // 刷新后 agentReattach 把还在跑的那一轮接了回来
    useAgentStreamStore().initStream('chat-1', 'agent-session-1', 'typing-1')

    mountHost()

    expect(executeAgent).not.toHaveBeenCalled()
    expect(queue.queues['chat-1']).toHaveLength(1)
  })
})
