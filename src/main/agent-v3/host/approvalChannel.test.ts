import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcHandlers = new Set<(...args: unknown[]) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (_channel: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers.add(handler)
    },
    removeListener: (_channel: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers.delete(handler)
    }
  }
}))

import { createApprovalRequester, resendPendingApprovals } from './approvalChannel'
import type { ApprovalRequest } from '../core/approval'

function fakeSender(id: number): {
  id: number
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
} {
  return { id, isDestroyed: () => false, send: vi.fn() }
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    sessionId: 'session-1',
    toolCallId: 'call-1',
    toolName: 'ue_actor_destroy',
    namespace: 'ue',
    risk: 'destructive',
    args: { path: '/Game/Foo' },
    allowAlways: true,
    ...overrides
  }
}

/** 回复一次审批：模拟渲染层点了按钮 */
function reply(toolCallId: string, verdict: 'approve' | 'reject'): void {
  for (const handler of [...ipcHandlers]) {
    handler({} as never, { toolCallId, verdict })
  }
}

/**
 * 审批弹窗必须能在刷新之后补发。
 *
 * agent 跑在主进程，刷新只重启了界面：弹窗和它的状态没了，主进程还阻塞在
 * beforeToolCall 里等回复 —— 不补发就一直等到 5 分钟超时，然后按拒绝处理。
 * 用户看到的是「刷新之后卡住不动，最后说这一步被拒绝了」，而他没点过拒绝。
 */
describe('resendPendingApprovals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipcHandlers.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('把还等着的那条重新发一遍，内容和第一次完全一致', () => {
    const sender = fakeSender(1)
    const pending = createApprovalRequester(sender as never)(request())

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(resendPendingApprovals(sender as never, ['session-1'])).toBe(1)
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(sender.send.mock.calls[1]).toEqual(sender.send.mock.calls[0])

    reply('call-1', 'approve')
    return expect(pending).resolves.toBe('approve')
  })

  it('用户已经点过的不再补发', async () => {
    const sender = fakeSender(1)
    const pending = createApprovalRequester(sender as never)(request())

    reply('call-1', 'reject')
    await expect(pending).resolves.toBe('reject')

    expect(resendPendingApprovals(sender as never, ['session-1'])).toBe(0)
  })

  it('不补发别的会话、也不补发别的窗口的审批', () => {
    const owner = fakeSender(1)
    const stranger = fakeSender(2)
    void createApprovalRequester(owner as never)(request())

    // 会话对不上
    expect(resendPendingApprovals(owner as never, ['session-2'])).toBe(0)
    // 窗口对不上：事件是往当初那个 webContents 发的，别的窗口认领只会弹出
    // 一个它根本没在跑的操作的确认框
    expect(resendPendingApprovals(stranger as never, ['session-1'])).toBe(0)
    expect(stranger.send).not.toHaveBeenCalled()

    reply('call-1', 'reject')
  })

  it('没有待审批时不发任何东西', () => {
    const sender = fakeSender(1)
    expect(resendPendingApprovals(sender as never, [])).toBe(0)
    expect(sender.send).not.toHaveBeenCalled()
  })
})
