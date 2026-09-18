import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAgentStreamStore } from './agentStream'

/**
 * 「这条对话还能不能接下一句」只有一个判据：`isBusy`。
 *
 * 光看流式状态是不够的 —— 主进程的收尾顺序是
 * 发 `done`（事件流最后一条）→ `prompt()` 返回 → 摘登记表 → 发 `released`。
 * 界面收到 `done` 就把流式标志清了，可后台还没空出来；这个间隙里发出去会被
 * 顶回来一句「会话正在执行中」，而排队投递是**先出队再发**的，
 * 那条话就此消失，用户什么提示都看不到。
 */
describe('agentStream 的「忙」判据', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('发起那一刻就算忙', () => {
    const store = useAgentStreamStore()
    store.initStream('chat-1', 'agent-1', 'typing-1')
    store.markAwaitingRelease('chat-1', 'agent-1')

    expect(store.isBusy('chat-1')).toBe(true)
  })

  /** 这一条就是整个机制存在的理由 */
  it('收到 done、流式已停，但没等到 released —— 仍然算忙', () => {
    const store = useAgentStreamStore()
    store.initStream('chat-1', 'agent-1', 'typing-1')
    store.markAwaitingRelease('chat-1', 'agent-1')
    store.endStream('agent-1')

    expect(store.isStreaming('chat-1')).toBe(false)
    expect(store.isBusy('chat-1')).toBe(true)
  })

  it('released 到了才算空出来', () => {
    const store = useAgentStreamStore()
    store.initStream('chat-1', 'agent-1', 'typing-1')
    store.markAwaitingRelease('chat-1', 'agent-1')
    store.endStream('agent-1')
    store.clearAwaitingRelease('agent-1')

    expect(store.isBusy('chat-1')).toBe(false)
  })

  /**
   * 启动失败那一轮压根没跑起来，主进程不会发 `released`。
   * 不摘标记的话这条对话会永远显示「忙」，之后排的话一条都发不出去。
   */
  it('启动失败摘掉标记后不再算忙', () => {
    const store = useAgentStreamStore()
    store.markAwaitingRelease('chat-1', 'agent-1')
    expect(store.isBusy('chat-1')).toBe(true)

    store.clearAwaitingRelease('agent-1')
    expect(store.isBusy('chat-1')).toBe(false)
  })

  it('别的对话在忙不影响这一条', () => {
    const store = useAgentStreamStore()
    store.markAwaitingRelease('chat-2', 'agent-2')

    expect(store.isBusy('chat-1')).toBe(false)
    expect(store.isBusy('chat-2')).toBe(true)
  })

  /**
   * 闪存不进界面：插话条目只记这句话本身。
   *
   * 曾经这里跟着塞过一份「当时选了什么」的摘要 —— 用户刚做完那个选择，
   * 再显示一遍是噪音。闪存是后台的潜规则。
   */
  it('插话条目只记文本，不带任何闪存信息', () => {
    const store = useAgentStreamStore()
    store.initStream('chat-1', 'agent-1', 'typing-1')

    expect(store.pushUserSteer('agent-1', '这个也改了', 'steer-1')).toBe(true)

    const item = store.getAgentProcess('chat-1').at(-1)
    expect(item?.type).toBe('user-steer')
    // 只有这句话本身、它的状态、以及撤回时用来指认它的号 —— 再多一个字段就要问清楚是什么
    expect(Object.keys(item?.data ?? {}).sort()).toEqual([
      'applied',
      'cancelled',
      'sessionId',
      'steerId',
      'text'
    ])
    expect(item?.data).toMatchObject({ text: '这个也改了', applied: false, cancelled: false })
  })
})
