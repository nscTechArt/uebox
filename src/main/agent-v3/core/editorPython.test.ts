import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRequest, getConnectionCount } = vi.hoisted(() => ({
  callRequest: vi.fn(),
  getConnectionCount: vi.fn(() => 1)
}))
vi.mock('../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ callRequest, getConnectionCount }) }
}))
vi.mock('./projectTargetContext', () => ({ getTargetConnectionId: () => 'geometry-test' }))

import { parsePythonLogs, runEditorPython } from './editorPython'

/**
 * 这段坏了的表现是「脚本明明跑了、返回里什么都没有」，不会报错 —— 所以要有测试。
 */
describe('parsePythonLogs', () => {
  it('捡出结果行，其余当 stdout', () => {
    const parsed = parsePythonLogs([
      { message: '开始处理' },
      { message: '__UA_RESULT__{"count":3}' }
    ])
    expect(parsed.output).toEqual({ count: 3 })
    expect(parsed.stdout).toBe('开始处理')
  })

  it('用户脚本自己 print 了带前缀的行时，以我们追加的最后一条为准', () => {
    const parsed = parsePythonLogs([
      { message: '__UA_RESULT__{"fake":true}' },
      { message: '__UA_RESULT__{"count":1}' }
    ])
    expect(parsed.output).toEqual({ count: 1 })
  })

  it('脚本没设 output_data 时结果行是 null，不当作结构化输出', () => {
    const parsed = parsePythonLogs([{ message: '__UA_RESULT__null' }])
    expect(parsed.output).toBeUndefined()
    expect(parsed.stdout).toBeUndefined()
  })

  it('结果行不是合法 JSON 时不抛，stdout 仍然保留', () => {
    const parsed = parsePythonLogs([
      { message: 'hello' },
      { message: '__UA_RESULT__<Object 0x1234>' }
    ])
    expect(parsed.output).toBeUndefined()
    expect(parsed.stdout).toBe('hello')
    expect(parsed.error).toContain('无法解析')
  })

  it('stdout 截尾到 8000 字符', () => {
    const parsed = parsePythonLogs([{ message: 'x'.repeat(9000) }])
    expect(parsed.stdout).toHaveLength(8000)
  })

  it('空 logs 不炸', () => {
    expect(parsePythonLogs(undefined).error).toContain('未收到')
  })
})

describe('runEditorPython', () => {
  beforeEach(() => {
    callRequest.mockReset()
    getConnectionCount.mockReturnValue(1)
  })
  afterEach(() => vi.useRealTimers())

  it('定向调用并等待超过一分钟，回传结构化结果', async () => {
    vi.useFakeTimers()
    callRequest.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, logs: [{ message: '__UA_RESULT__{"after":100}' }] }),
            65_000
          )
        )
    )
    const result = runEditorPython('output_data = {"after": 100}', '减面')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(await result).toEqual({ success: true, output: { after: 100 }, stdout: undefined })
    expect(callRequest).toHaveBeenCalledWith(
      'cmd.run_python',
      { script: expect.stringContaining("globals().pop('output_data', None)") },
      'geometry-test',
      300_000
    )
  })

  it('缺失或损坏的完成结果不能报成功', async () => {
    for (const message of ['processing', '__UA_RESULT__{"after":']) {
      callRequest.mockResolvedValue({ ok: true, logs: [{ message }] })
      expect(await runEditorPython('pass', '几何编辑')).toMatchObject({
        success: false,
        error: expect.stringContaining('未确认执行结果')
      })
    }
  })

  it('异常栈和失败前的诊断一起保留', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      result: 'RuntimeError: source mesh is open',
      logs: [{ message: 'closed=False' }]
    })
    expect(await runEditorPython('raise RuntimeError()', '布尔')).toEqual({
      success: false,
      error: 'RuntimeError: source mesh is open',
      stdout: 'closed=False'
    })
  })

  it('断线和已取消的请求都不发给编辑器', async () => {
    getConnectionCount.mockReturnValue(0)
    expect((await runEditorPython('pass', '检查')).success).toBe(false)
    getConnectionCount.mockReturnValue(1)
    expect((await runEditorPython('pass', '检查', 300_000, AbortSignal.abort())).success).toBe(
      false
    )
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('取消只停止等待，并移除监听器', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    callRequest.mockReturnValue(new Promise(() => {}))
    const result = runEditorPython('pass', '布尔', 300_000, controller.signal)
    controller.abort()
    expect(await result).toMatchObject({
      success: false,
      error: expect.stringContaining('脚本可能仍在执行')
    })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  /**
   * 超时和「用户按了停止」落在同一个 catch 里，但话不能是同一句。
   *
   * 这个 error 有两条路会原样弹给用户看（openAsset 走 message.warning、
   * reviewChanges 进审查面板），所以「编辑器可能卡死了，请重启」这种排查指引
   * 不能拼在这里 —— 用户只是按了个停止。指引由 ue_run_python_script 按
   * `unconfirmed` 自己补，那一层面对的才是模型。
   */
  it('中止和超时分开标记，都不在 error 里拼排查指引', async () => {
    const controller = new AbortController()
    callRequest.mockReturnValue(new Promise(() => {}))
    const aborted = runEditorPython('pass', '布尔', 300_000, controller.signal)
    controller.abort()
    expect(await aborted).toMatchObject({ aborted: true, unconfirmed: true })
    expect((await aborted).error).not.toContain('重启编辑器')

    callRequest.mockRejectedValueOnce(new Error('timeout'))
    const timedOut = await runEditorPython('pass', '检查')
    expect(timedOut).toMatchObject({ unconfirmed: true })
    expect(timedOut.aborted).toBeUndefined()
    expect(timedOut.error).not.toContain('重启编辑器')
  })

  it('正常完成也移除取消监听器', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    callRequest.mockResolvedValue({ ok: true, logs: [{ message: '__UA_RESULT__null' }] })
    expect((await runEditorPython('pass', '检查', 300_000, controller.signal)).success).toBe(true)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
