import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePendingApprovalsStore, type PendingApproval } from './pendingApprovals'

const replyApproval = vi.fn()

vi.mock('@renderer/api/agentV3', () => ({
  agentV3API: {
    replyApproval: (toolCallId: string, verdict: string) => replyApproval(toolCallId, verdict)
  }
}))

function approval(toolCallId: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    sessionId: 'session-1',
    toolCallId,
    toolName: 'delete_asset',
    namespace: 'asset',
    risk: 'destructive',
    args: { path: '/Game/Foo' },
    allowAlways: true,
    ...overrides
  }
}

describe('待审批队列', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    replyApproval.mockClear()
  })

  it('存在 store 里，切走再回来还在', () => {
    const store = usePendingApprovalsStore()
    store.enqueue(approval('call-1'))

    // 组件卸载又挂载：拿到的是同一个 store，队列不受影响
    expect(usePendingApprovalsStore().current?.toolCallId).toBe('call-1')
  })

  it('同一条补发两遍只排一次', () => {
    const store = usePendingApprovalsStore()
    store.enqueue(approval('call-1'))
    store.enqueue(approval('call-1'))

    expect(store.queue).toHaveLength(1)
  })

  it('并行审批按先来后到排队，答完一条接着弹下一条', () => {
    const store = usePendingApprovalsStore()
    store.enqueue(approval('call-1'))
    store.enqueue(approval('call-2'))

    expect(store.current?.toolCallId).toBe('call-1')

    store.reply('call-1', 'approve')

    expect(replyApproval).toHaveBeenCalledWith('call-1', 'approve')
    expect(store.current?.toolCallId).toBe('call-2')
  })

  it('别处落定的那条直接收掉，不回传', () => {
    const store = usePendingApprovalsStore()
    store.enqueue(approval('call-1'))

    store.settle('call-1')

    expect(store.current).toBeNull()
    expect(replyApproval).not.toHaveBeenCalled()
  })

  it('已经落定的审批再点一次不会重复回传', () => {
    const store = usePendingApprovalsStore()
    store.enqueue(approval('call-1'))
    store.settle('call-1')

    store.reply('call-1', 'reject')

    expect(replyApproval).not.toHaveBeenCalled()
  })

  it('没有 toolCallId 的请求不收', () => {
    const store = usePendingApprovalsStore()

    store.enqueue(approval(''))

    expect(store.queue).toHaveLength(0)
  })

  describe('用户指名要答哪一条', () => {
    it('指名的那条排在先到的前面', () => {
      const store = usePendingApprovalsStore()
      store.enqueue(approval('call-1'))
      store.enqueue(approval('call-2'))

      store.focus('call-2')

      expect(store.current?.toolCallId).toBe('call-2')
    })

    /*
     * 最需要它的场合恰恰是队列还空着：点通知时界面没挂载，主进程存的激活要等
     * 布局挂上来才取回，而待审批不落盘、要等 reattach 补发 —— 补发一定在后面。
     */
    it('队列还空着就指名，等补发上来照样生效', () => {
      const store = usePendingApprovalsStore()

      store.focus('call-2')
      store.enqueue(approval('call-1'))
      store.enqueue(approval('call-2'))

      expect(store.current?.toolCallId).toBe('call-2')
    })

    it('指名的那条答完，指名就失效，不压着后面排队的', () => {
      const store = usePendingApprovalsStore()
      store.enqueue(approval('call-1'))
      store.enqueue(approval('call-2'))
      store.focus('call-2')

      store.reply('call-2', 'approve')

      expect(store.current?.toolCallId).toBe('call-1')
    })
  })
})
