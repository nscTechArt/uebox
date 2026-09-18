// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 工厂会被提升到文件最顶部，先于普通 const 执行——工厂里引用的
// mock 函数必须用 vi.hoisted 声明，否则是 TDZ ReferenceError
const mocks = vi.hoisted(() => ({
  callRequest: vi.fn(),
  getConnectionCount: vi.fn(() => 1),
  engines: vi.fn(),
  spawn: vi.fn(),
  foregroundUnrealEditorWindow: vi.fn(async () => undefined)
}))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({
      callRequest: mocks.callRequest,
      getConnectionCount: mocks.getConnectionCount
    })
  }
}))
vi.mock('../../../../utils/UnrealPathManager', () => ({
  default: { findUnrealEnginePaths: mocks.engines }
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  getTargetProjectPath: () => 'H:/Projects/MyGame'
}))
vi.mock('child_process', () => ({ spawn: mocks.spawn, default: { spawn: mocks.spawn } }))
vi.mock('./foregroundEditorWindow', () => ({
  foregroundUnrealEditorWindow: mocks.foregroundUnrealEditorWindow
}))

import { INSIGHTS_TRACE_TOOL_NAME, createInsightsTraceTool } from './insightsTrace'
import { assertFreshFile } from '../../assertFreshFile'

vi.mock('../../assertFreshFile', () => ({ assertFreshFile: vi.fn(async () => undefined) }))

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createInsightsTraceTool() as unknown as Executable).execute(input)

beforeEach(() => {
  vi.mocked(assertFreshFile).mockReset().mockResolvedValue(undefined)
  mocks.callRequest.mockReset()
  mocks.getConnectionCount.mockReset().mockReturnValue(1)
  mocks.foregroundUnrealEditorWindow.mockClear()
})

/**
 * capture 分支：原 `ue_capture_insights_trace` 的全部回归防线原样保留。
 */
describe(`${INSIGHTS_TRACE_TOOL_NAME} action=capture`, () => {
  it('拒绝录制返回的旧 trace', async () => {
    mocks.callRequest.mockResolvedValueOnce({ ok: true, utrace_path: 'old.utrace' })
    vi.mocked(assertFreshFile).mockRejectedValueOnce(new Error('返回的是旧文件'))
    const result = await run({ action: 'capture' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('旧文件')
    expect(assertFreshFile).toHaveBeenCalledWith('old.utrace', expect.any(Number))
  })
  it('录制成功：把 .utrace 路径原样带回，并提示下一步用同一个工具的 analyze', async () => {
    mocks.callRequest.mockResolvedValueOnce({
      ok: true,
      utrace_path: 'C:/Proj/Saved/Profiling/UnrealAgentLink/Capture_20260830_120000.utrace',
      channels: 'cpu,gpu,frame,bookmark',
      requested_duration_seconds: 10,
      actual_elapsed_seconds: 12.0
    })

    const r = await run({
      action: 'capture',
      duration_seconds: 10,
      channels: 'cpu,gpu,frame,bookmark'
    })

    expect(r.success).toBe(true)
    expect(r.utrace_path).toContain('.utrace')
    // 下一步的提示必须指向**存在的**入口：旧名 ue_analyze_insights_trace 已下线
    expect(String(r.message)).toContain(`${INSIGHTS_TRACE_TOOL_NAME}(action="analyze"`)
    expect(String(r.message)).not.toContain('ue_analyze_insights_trace')
  })

  it('不给 duration / channels 时按原默认值（10 秒、cpu,gpu,frame,bookmark）发请求', async () => {
    mocks.callRequest.mockResolvedValueOnce({ ok: true, utrace_path: 'C:/Proj/Capture.utrace' })

    await run({ action: 'capture' })

    expect(mocks.callRequest).toHaveBeenCalledWith(
      'system.capture_insights_trace',
      { duration_seconds: 10, channels: 'cpu,gpu,frame,bookmark' },
      'conn-1',
      10 * 1000 + 30000
    )
  })

  it('这是只录制不解析的分支——响应里不该出现任何统计数字字段', async () => {
    mocks.callRequest.mockResolvedValueOnce({ ok: true, utrace_path: 'C:/Proj/Capture.utrace' })

    const r = await run({ action: 'capture' })

    expect(r).not.toHaveProperty('stats')
    expect(r).not.toHaveProperty('avg_fps')
    expect(r).not.toHaveProperty('top_entries')
  })

  it('插件端拒绝（已有连接在录）时把原因原样透传', async () => {
    mocks.callRequest.mockResolvedValueOnce({
      ok: false,
      error: 'Could not start the trace. A trace connection may already be active',
      __rpc: { code: 409 }
    })

    const r = await run({ action: 'capture', duration_seconds: 10 })

    expect(r.success).toBe(false)
    expect(r.code).toBe(409)
  })

  it('没连接引擎时不发请求', async () => {
    mocks.getConnectionCount.mockReturnValueOnce(0)

    const r = await run({ action: 'capture' })

    expect(r.success).toBe(false)
    expect(mocks.callRequest).not.toHaveBeenCalled()
  })

  /**
   * 录制前必须先拉窗口前台——和 ue_capture_perf_trace 同一条回归防线。
   */
  it('录制前先尝试拉编辑器窗口前台，且在发出录制请求之前', async () => {
    mocks.callRequest.mockResolvedValueOnce({ ok: true, utrace_path: 'C:/Proj/Capture.utrace' })

    await run({ action: 'capture', duration_seconds: 10 })

    expect(mocks.foregroundUnrealEditorWindow).toHaveBeenCalledTimes(1)
    const foregroundOrder = mocks.foregroundUnrealEditorWindow.mock.invocationCallOrder[0]!
    const requestOrder = mocks.callRequest.mock.invocationCallOrder[0]!
    expect(foregroundOrder).toBeLessThan(requestOrder)
  })
})

/**
 * analyze 分支：原 `ue_analyze_insights_trace` 的全部回归防线原样保留。
 */
describe(`${INSIGHTS_TRACE_TOOL_NAME} action=analyze`, () => {
  let root: string
  let trace: string
  let binary: string

  function install(platform: 'darwin' | 'win32'): void {
    vi.stubGlobal('process', { ...process, platform })
    binary = join(
      root,
      platform === 'darwin'
        ? 'Engine/Binaries/Mac/UnrealInsights.app/Contents/MacOS/UnrealInsights'
        : 'Engine/Binaries/Win64/UnrealInsights.exe'
    )
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, '', { mode: 0o755 })
  }

  const analyze = (): Promise<ToolResult> => run({ action: 'analyze', utrace_path: trace })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uebox-insights-'))
    trace = join(root, '中文 trace.utrace')
    writeFileSync(trace, '')
    mocks.callRequest.mockResolvedValue({
      engine_major: 5,
      engine_minor: 6,
      engine_dir: join(root, 'Engine')
    })
    mocks.engines.mockReset().mockResolvedValue([{ rootPath: root, version: '5.6.1' }])
    mocks.spawn.mockReset().mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      })
      queueMicrotask(() => {
        writeFileSync(trace.replace('.utrace', '.timerstats.csv'), 'Name,Total Time\nTick,1.5\n')
        child.emit('close', 0)
      })
      return child
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
  })

  it('没给 utrace_path 时明说要先 capture，不发任何请求、不起进程', async () => {
    const r = await run({ action: 'analyze' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('utrace_path')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'win32'] as const)(
    'uses the current engine and correct %s binary',
    async (platform) => {
      install(platform)
      expect((await analyze()).success).toBe(true)
      expect(mocks.engines).not.toHaveBeenCalled()
      expect(mocks.spawn).toHaveBeenCalledWith(
        binary,
        expect.arrayContaining([
          `-OpenTraceFile=${trace}`,
          `-ExecOnAnalysisCompleteCmd=TimingInsights.ExportTimerStatistics "${trace.replace('.utrace', '.timerstats.csv')}"`
        ]),
        expect.anything()
      )
    }
  )

  it('历史 trace 可分析，新鲜度只检查本次导出的 CSV', async () => {
    install('win32')
    utimesSync(trace, 1, 1)
    const actual =
      await vi.importActual<typeof import('../../assertFreshFile')>('../../assertFreshFile')
    vi.mocked(assertFreshFile).mockImplementation(actual.assertFreshFile)
    expect((await analyze()).success).toBe(true)
    expect(assertFreshFile).toHaveBeenCalledWith(
      trace.replace('.utrace', '.timerstats.csv'),
      expect.any(Number)
    )
    expect(assertFreshFile).not.toHaveBeenCalledWith(trace, expect.anything())
  })

  it('拒绝分析器交回的旧 CSV', async () => {
    install('win32')
    vi.mocked(assertFreshFile).mockRejectedValueOnce(new Error('返回的是旧文件'))
    const result = await analyze()
    expect(result.success).toBe(false)
    expect(result.error).toContain('旧文件')
  })

  it('falls back to discovered engines including a patch version when engine_dir is absent', async () => {
    install('win32')
    mocks.callRequest.mockResolvedValue({ engine_major: 5, engine_minor: 6 })
    expect((await analyze()).success).toBe(true)
    expect(mocks.engines).toHaveBeenCalledOnce()
  })

  it('does not launch an absent Mac program or silently substitute the Windows executable', async () => {
    install('win32')
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    expect((await analyze()).success).toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('reports native process failures instead of presenting them as empty export bugs', async () => {
    install('darwin')
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      })
      queueMicrotask(() => {
        child.stderr.emit('data', 'Library not loaded')
        child.emit('close', 1)
      })
      return child
    })
    const result = await analyze()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Library not loaded')
  })
})
