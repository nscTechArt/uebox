/**
 * @vitest-environment node
 *
 * `ue_capture_perf_trace` 的契约测试。
 *
 * 核心是「idle_sample 必须原样传给模型的措辞里」——这个工具和
 * `ue_get_performance_stats` 共用同一条纪律：渲染线程和 GPU 全程接近 0
 * 时，报出去的话不能听起来像一个性能结论。
 *
 * 另一条是「采样前必须先拉一次编辑器窗口前台」——首个真机测试就撞上了这个
 * 回归：这个工具最初照抄了 CSV Profiler 的调用逻辑，但漏了
 * `ue_get_performance_stats` 一直有的这一步，于是比旧工具更容易采到空转
 * 样本，而且要等完整个 duration_seconds 才发现白采了。这里锁死调用顺序，
 * 不再丢第二次。
 */

import { describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)
// vi.mock 工厂会被提升到文件最顶部，先于普通 const 执行——工厂里引用的
// mock 函数必须用 vi.hoisted 声明，否则是 TDZ ReferenceError
const { foregroundUnrealEditorWindow } = vi.hoisted(() => ({
  foregroundUnrealEditorWindow: vi.fn(async () => undefined)
}))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  // 相对路径要按工程目录落回去（见 engineOutputPath.ts），所以这里得有工程
  getTargetProjectPath: () => 'H:/Projects/MyGame'
}))

vi.mock('./foregroundEditorWindow', () => ({ foregroundUnrealEditorWindow }))

import { createCapturePerfTraceTool } from './capturePerfTrace'
import { assertFreshFile } from '../../assertFreshFile'

vi.mock('../../assertFreshFile', () => ({ assertFreshFile: vi.fn(async () => undefined) }))

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown = {}): Promise<ToolResult> =>
  (createCapturePerfTraceTool() as unknown as Executable).execute(input)

describe('ue_capture_perf_trace', () => {
  it('旧产物不能作为本次采样成功返回', async () => {
    callRequest.mockResolvedValueOnce({ ok: true, csv_path: 'old.csv' })
    vi.mocked(assertFreshFile).mockRejectedValueOnce(new Error('返回的是旧文件'))
    const result = await run()
    expect(result.success).toBe(false)
    expect(result.error).toContain('旧文件')
    expect(assertFreshFile).toHaveBeenCalledWith('old.csv', expect.any(Number))
  })
  it('正常采样：给出 fps、瓶颈判断，并提醒数据采自编辑器', async () => {
    callRequest.mockResolvedValueOnce({
      ok: true,
      csv_path: 'C:/Proj/Saved/Profiling/CSV/Capture.csv',
      frame_count: 300,
      requested_duration_seconds: 10,
      actual_elapsed_seconds: 10.1,
      gpu_stats_enabled: false,
      stats: {
        FrameTime: { avg: 16.6, min: 10, max: 40, p50: 16, p95: 25, p99: 35 },
        GameThreadTime: { avg: 5, min: 2, max: 10, p50: 5, p95: 8, p99: 9 },
        RenderThreadTime: { avg: 4, min: 1, max: 9, p50: 4, p95: 7, p99: 8 },
        GPUTime: { avg: 12, min: 5, max: 30, p50: 11, p95: 20, p99: 28 }
      },
      avg_fps: 60.2,
      p99_fps: 28.6,
      worst_frame: { FrameTime: 40, GameThreadTime: 10, RenderThreadTime: 9, GPUTime: 30 },
      bottleneck: 'GPU',
      idle_sample: false
    })

    const r = await run({ duration_seconds: 10, gpu_stats: false })

    expect(r.success).toBe(true)
    expect(r.bottleneck).toBe('GPU')
    expect(String(r.message)).toContain('60.2 FPS')
    expect(String(r.message)).toContain('瓶颈：GPU')
    expect(String(r.message)).toContain('不等于打包后')
    expect(String(r.message)).not.toContain('警告')
  })

  it('idle_sample 为真时，警告必须出现在给模型看的措辞里，而不是只在字段上', async () => {
    callRequest.mockResolvedValueOnce({
      ok: true,
      csv_path: 'C:/Proj/Saved/Profiling/CSV/Capture.csv',
      frame_count: 300,
      stats: {
        FrameTime: { avg: 200, min: 150, max: 250, p50: 200, p95: 240, p99: 248 },
        GameThreadTime: { avg: 195, min: 145, max: 245, p50: 195, p95: 235, p99: 243 },
        RenderThreadTime: { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 },
        GPUTime: { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 }
      },
      avg_fps: 5,
      bottleneck: 'GameThread',
      idle_sample: true
    })

    const r = await run({ duration_seconds: 10, gpu_stats: false })

    expect(r.success).toBe(true)
    expect(r.idle_sample).toBe(true)
    expect(String(r.message)).toContain('没有在渲染')
    expect(String(r.message)).toContain('PIE')
  })

  it('409（已经在采样）把插件原话透传，不额外加「失败」前缀', async () => {
    callRequest.mockResolvedValueOnce({
      ok: false,
      error: 'A capture is already in progress',
      __rpc: { code: 409 }
    })

    const r = await run({ duration_seconds: 10 })

    expect(r.success).toBe(false)
    expect(r.error).toBe('A capture is already in progress')
    expect(r.code).toBe(409)
  })

  it('没连接引擎时不发请求', async () => {
    getConnectionCount.mockReturnValueOnce(0)
    callRequest.mockClear()

    const r = await run({})

    expect(r.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('超时预算比采样时长多留余量，不是刚好等于', async () => {
    callRequest.mockResolvedValueOnce({ ok: true, stats: {}, frame_count: 1 })

    await run({ duration_seconds: 30 })

    const timeoutArg = callRequest.mock.calls.at(-1)![3] as number
    expect(timeoutArg).toBeGreaterThan(30000)
  })

  it('每次采样前都先尝试拉编辑器窗口前台，且在发出采样请求之前', async () => {
    foregroundUnrealEditorWindow.mockClear()
    callRequest.mockClear()
    callRequest.mockResolvedValueOnce({ ok: true, stats: {}, frame_count: 1 })

    await run({ duration_seconds: 10 })

    expect(foregroundUnrealEditorWindow).toHaveBeenCalledTimes(1)
    const foregroundOrder = foregroundUnrealEditorWindow.mock.invocationCallOrder[0]!
    const requestOrder = callRequest.mock.invocationCallOrder[0]!
    expect(foregroundOrder).toBeLessThan(requestOrder)
  })

  it('没连接引擎时不拉窗口——先判连接，别做没意义的动作', async () => {
    getConnectionCount.mockReturnValueOnce(0)
    foregroundUnrealEditorWindow.mockClear()

    await run({})

    expect(foregroundUnrealEditorWindow).not.toHaveBeenCalled()
  })
})
