import { beforeEach, describe, expect, it, vi } from 'vitest'

import { agentV3API } from './agentV3'

/**
 * 闪存是发送路上**顺带**的一步。
 *
 * 抓不到就是这条消息不带快照，绝不能因此让消息发不出去 —— 所以这一层的全部
 * 职责就是：不管底下出什么事，都给调用方一个能往下走的返回值。
 */
describe('agentV3API.captureEditorSnapshot', () => {
  beforeEach(() => {
    // @ts-expect-error 测试环境里没有 preload 注入的 window.api
    window.api = { agentV3: {} }
  })

  it('抓到了就把快照交出去', async () => {
    const snapshot = {
      capturedAt: '2026-09-07T14:21:33.000Z',
      project: { projectName: 'GameA', connectionId: 'conn-a' },
      focus: {}
    }
    window.api.agentV3.captureEditorSnapshot = vi
      .fn()
      .mockResolvedValue({ success: true, data: { ok: true, snapshot } })

    await expect(agentV3API.captureEditorSnapshot({})).resolves.toEqual({ ok: true, snapshot })
  })

  /**
   * 外层是 `{ success: true, data }`，抓取本身的失败在 `data.ok` 里。
   *
   * 两层要分开：把抓取失败编码成 `success: false` 的话，`unwrapResult` 会抛，
   * 而这条路上抛异常就等于用户按了发送没反应。
   */
  it('抓取失败（data.ok=false）不抛，原样交给调用方降级', async () => {
    window.api.agentV3.captureEditorSnapshot = vi
      .fn()
      .mockResolvedValue({ success: true, data: { ok: false, reason: 'project-offline' } })

    await expect(agentV3API.captureEditorSnapshot({})).resolves.toEqual({
      ok: false,
      reason: 'project-offline'
    })
  })

  it('IPC 本身抛了也兜住 —— 发送流程不能因为闪存断掉', async () => {
    window.api.agentV3.captureEditorSnapshot = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(agentV3API.captureEditorSnapshot({})).resolves.toEqual({
      ok: false,
      reason: 'error'
    })
  })

  it('主进程回了个 success:false 也兜住', async () => {
    window.api.agentV3.captureEditorSnapshot = vi
      .fn()
      .mockResolvedValue({ success: false, error: '炸了' })

    await expect(agentV3API.captureEditorSnapshot({})).resolves.toEqual({
      ok: false,
      reason: 'error'
    })
  })

  /** 排队的、插的最终都落在正在跑的那一轮上，得跟着它盯的工程抓 */
  it('runningSessionId 原样传下去', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ success: true, data: { ok: false, reason: 'error' } })
    window.api.agentV3.captureEditorSnapshot = invoke

    await agentV3API.captureEditorSnapshot({
      sessionProject: { projectName: 'GameA' },
      runningSessionId: 'agent-1'
    })

    expect(invoke).toHaveBeenCalledWith({
      sessionProject: { projectName: 'GameA' },
      runningSessionId: 'agent-1'
    })
  })
})
