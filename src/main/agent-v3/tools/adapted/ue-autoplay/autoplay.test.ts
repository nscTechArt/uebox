// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import type { PieRunReport } from './types'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  runner: vi.fn(),
  accept: vi.fn(),
  binding: vi.fn(),
  request: vi.fn(),
  ready: vi.fn(),
  close: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => 'C:/test-user-data' } }))
vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ getConnectionCount: () => 1, callRequest: mocks.call })
  }
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'project-connection'
}))
vi.mock('../../../../ai/judge', () => ({
  resolveJudgeBinding: mocks.binding,
  requestJudgement: mocks.request,
  judgeAvailable: vi.fn().mockResolvedValue(true),
  judge: vi.fn()
}))
vi.mock('./runner', () => ({ runAutoplay: mocks.runner }))
vi.mock('./rpc', async (original) => ({
  ...(await original<typeof import('./rpc')>()),
  waitForPlay: mocks.ready
}))
vi.mock('./trace', () => ({ createFileTrace: () => ({ path: 'trace.jsonl', close: mocks.close }) }))
vi.mock('./visualAcceptance', async (original) => ({
  ...(await original<typeof import('./visualAcceptance')>()),
  acceptAutoplayVisually: mocks.accept
}))
vi.mock('../ue-editor/screenshot', () => ({ readScreenshotImage: vi.fn().mockResolvedValue([]) }))
vi.mock('../ue-editor/playtest', () => ({ withPieBusyHint: (message: string) => message }))

import { runWithEditorScreenshotScope } from '../../../core/editorScreenshotScope'
import { createAutoplayTool } from './autoplay'

const checks = [{ id: 'win', description: '通关面板出现' }]
let finish: (report: PieRunReport) => void
async function run(input: unknown, abortSignal?: AbortSignal): Promise<Record<string, unknown>> {
  const tool = createAutoplayTool()
  const parsed = (tool.inputSchema as z.ZodType).parse(input)
  return (await tool.execute!(parsed, { abortSignal })) as Record<string, unknown>
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.binding.mockResolvedValue({ provider: { id: 'typesafe' }, modelId: 'jev-1.14.0' })
  mocks.ready.mockResolvedValue('ready')
  mocks.runner.mockResolvedValue({
    outcome: 'goal_reached',
    steps: 1,
    decisions: 1,
    distanceTravelled: 1,
    cellsVisited: 1,
    calibrationNotes: [],
    findings: [],
    sweep: [],
    uiClicks: [],
    uiDenied: [],
    inputWarnings: [],
    goal: { reached: true, logSeen: true }
  })
  mocks.call.mockImplementation(async (method: string) => {
    if (method === 'pie.run')
      return new Promise<PieRunReport>((resolve) => {
        finish = resolve
      })
    if (method === 'pie.stop') {
      finish({ ok: true, frame_mode: 'window', frames: [] })
      return { ok: true }
    }
    if (method === 'pie.observe') return { playing: true, session_active: true, session_elapsed: 2 }
    if (method === 'editor.capture_app_window')
      return { saved: true, path: 'last.png', window_source: 'requested' }
    throw new Error(`Unexpected RPC ${method}`)
  })
  mocks.accept.mockResolvedValue({
    status: 'not_passed',
    model: 'jev-1.14.0',
    checks: [{ ...checks[0], status: 'not_observed' }],
    frames: [],
    blockers: [],
    warnings: [],
    image_paths: ['timeline.png'],
    replay_path: 'replay.webp',
    report_path: 'report.json'
  })
})

describe('ue_autoplay visual integration', () => {
  it('captures HUD before stopping early, uses the pinned judge, and presents failure ahead of controller success', async () => {
    const result = await run({ visual_checks: checks, goal: { until_log: 'Victory' } })
    expect(mocks.call.mock.calls[0]).toEqual([
      'pie.run',
      expect.objectContaining({ frames: 18, frame_mode: 'window' }),
      'project-connection',
      150_000
    ])
    const calls = mocks.call.mock.calls.map((call) => call[0])
    expect(calls.indexOf('editor.capture_app_window')).toBeLessThan(calls.indexOf('pie.stop'))
    expect(mocks.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        finalFrame: { at: 2, path: 'last.png' },
        requiredLog: 'Victory',
        logSeen: true
      })
    )
    await mocks.accept.mock.calls[0][0].ask({}, {}, { assets: {} })
    expect(mocks.request).toHaveBeenCalledWith(
      { id: 'typesafe' },
      'jev-1.14.0',
      {},
      {},
      4000,
      undefined,
      { assets: {} }
    )
    expect(result.summary).toMatch(/^视觉验收未通过/)
    expect(JSON.stringify(result)).toMatch(/^\{"summary":"视觉验收未通过/)
    expect(result.failed_count).toBe(1)
    expect(result.image_paths).toEqual(['replay.webp', 'timeline.png'])
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('ordinary autoplay does not acquire a judge or send window images', async () => {
    await run({ mode: 'explore' })
    expect(mocks.binding).not.toHaveBeenCalled()
    expect(mocks.accept).not.toHaveBeenCalled()
    expect(mocks.call.mock.calls[0][1]).not.toHaveProperty('frames')
    expect(mocks.call.mock.calls.some((call) => call[0] === 'editor.capture_app_window')).toBe(
      false
    )
  })

  it('refuses visual work before PIE starts when screenshots are disabled', async () => {
    const result = await runWithEditorScreenshotScope(false, () => run({ visual_checks: checks }))
    expect(result.success).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
    expect((await run({ visual_checks: checks, screenshot: false })).success).toBe(false)
  })

  it('refuses missing judge configuration before PIE starts', async () => {
    mocks.binding.mockResolvedValue(null)
    expect((await run({ visual_checks: checks })).success).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('refuses a plan judge that cannot receive image assets before PIE starts', async () => {
    mocks.binding.mockResolvedValue({ provider: { id: 'creator-plan-judge' }, modelId: 'jev' })
    expect((await run({ visual_checks: checks })).success).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('a fallback editor window is never used as game evidence', async () => {
    const original = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation((method, ...args) =>
      method === 'editor.capture_app_window'
        ? { saved: true, path: 'wrong.png', window_source: 'fallback' }
        : original(method, ...args)
    )
    await run({ visual_checks: checks })
    expect(mocks.accept.mock.calls[0][0].finalFrame).not.toHaveProperty('path')
    expect(mocks.accept.mock.calls[0][0].finalFrame.error).toContain('不能用其他窗口')
  })

  it('cancellation and runner exceptions still stop PIE without the cancelled signal', async () => {
    const abort = new AbortController()
    mocks.runner.mockImplementation(async () => {
      abort.abort()
      throw new Error('cancelled')
    })
    expect((await run({ visual_checks: checks }, abort.signal)).success).toBe(false)
    expect(mocks.call).toHaveBeenCalledWith(
      'pie.stop',
      { reason: '机器人出错' },
      'project-connection',
      10_000
    )
    expect(mocks.accept).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('evidence persistence failure is reported after the session has stopped', async () => {
    mocks.accept.mockRejectedValueOnce(new Error('disk full'))
    const result = await run({ visual_checks: checks })
    expect(result.success).toBe(false)
    expect(result.error).toContain('视觉验收未完成：disk full')
    expect(mocks.call.mock.calls.some((call) => call[0] === 'pie.stop')).toBe(true)
  })

  it('rejects ambiguous duplicate milestone ids', async () => {
    await expect(run({ visual_checks: [checks[0], checks[0]] })).rejects.toThrow('id 必须唯一')
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
