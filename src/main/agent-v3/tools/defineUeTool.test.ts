import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../agent-v3/core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { callUeWhenRegistryReady, defineUeTool } from './defineUeTool'

const tool = defineUeTool({
  name: 'material_create',
  namespace: 'ue.material',
  method: 'material.create',
  description: 'x',
  input: z.object({ material_name: z.string() })
})

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('defineUeTool', () => {
  it('把参数透传给 RPC，并带上目标连接与超时', async () => {
    callRequest.mockResolvedValue({ material_path: '/Game/M_A' })

    await tool.execute('c1', { material_name: 'M_A' })

    // 第五个参数是中止信号：`execute` 没拿到 signal 时是 undefined，
    // 用户按停止那一路见 `abortable.test.ts` 和 server.test.ts
    expect(callRequest).toHaveBeenCalledWith(
      'material.create',
      { material_name: 'M_A' },
      'conn-1',
      30_000,
      undefined
    )
  })

  it('没有连接引擎时给出可操作的提示', async () => {
    getConnectionCount.mockReturnValue(0)

    // 要的是「下一步去问 ue_session_health」，不是「请确保引擎已启动并安装插件」——
    // 后者是首次安装的引导词，对着一个十分钟前还连着的用户说出来只会让他困惑
    await expect(tool.execute('c1', { material_name: 'M_A' })).rejects.toThrow('ue_session_health')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('不再把用户支去点一个不存在的「连接」按钮', async () => {
    getConnectionCount.mockReturnValue(0)

    // 连接方向是反的：插件主动连过来、断了每 5 秒自己重试，界面上根本没有这个按钮
    await expect(tool.execute('c1', { material_name: 'M_A' })).rejects.toThrow(
      /插件断线后每 5 秒自己重连/
    )
    await expect(tool.execute('c1', { material_name: 'M_A' })).rejects.not.toThrow(
      /在盒子里连接该项目/
    )
  })

  // UE 侧历史上有四种失败形状，V2 里每个工具各解一遍且解法不一致
  it.each([
    ['ok:false', { ok: false, error: '路径不存在' }],
    ['success:false', { success: false, message: '路径不存在' }]
  ])('识别 RPC 失败形状：%s', async (_label, response) => {
    callRequest.mockResolvedValue(response)

    // 必须抛 —— pi 只认异常，返回结果会被当成调用成功
    await expect(tool.execute('c1', { material_name: 'M_A' })).rejects.toThrow('路径不存在')
  })

  it('错误码和 details 拼进 message —— 模型只看得到 message', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: '资产被占用',
      __rpc: { code: 'E_LOCKED' },
      details: { owner: 'Editor' }
    })

    const error = await tool.execute('c1', { material_name: 'M_A' }).catch((e: Error) => e)
    const text = (error as Error).message

    expect(text).toContain('资产被占用')
    expect(text).toContain('E_LOCKED')
    expect(text).toContain('Editor')
  })

  it('引擎返回空数据算失败，而不是当成功往下走', async () => {
    callRequest.mockResolvedValue(null)

    await expect(tool.execute('c1', { material_name: 'M_A' })).rejects.toThrow('未返回数据')
  })

  it('toOutcome 决定给模型看什么，details 单独留给 UI', async () => {
    const withOutcome = defineUeTool<z.ZodTypeAny, { material_path: string }>({
      name: 'x',
      namespace: 'ue.material',
      method: 'material.create',
      description: 'x',
      input: z.object({ material_name: z.string() }),
      toOutcome: (r) => ({ text: `已创建 ${r.material_path}`, details: r })
    })
    callRequest.mockResolvedValue({ material_path: '/Game/M_A' })

    const result = await withOutcome.execute('c1', { material_name: 'M_A' })

    expect(result.content).toEqual([{ type: 'text', text: '已创建 /Game/M_A' }])
    expect(result.details).toEqual({ material_path: '/Game/M_A' })
  })

  it('自定义超时生效（编译类操作 30s 不够）', async () => {
    const slow = defineUeTool({
      name: 'material_compile',
      namespace: 'ue.material',
      method: 'material.compile',
      description: 'x',
      timeoutMs: 120_000,
      input: z.object({ path: z.string() })
    })
    callRequest.mockResolvedValue({ ok: true })

    await slow.execute('c1', { path: '/Game/M_A' })

    expect(callRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'conn-1',
      120_000,
      undefined
    )
  })
})

// 注册表没扫完：插件立刻回 registry_not_ready + 进度，盒子这边轮询状态、报进度、扫完重发。
// 守四件事：会重发、会报进度、取消就停、卡住就放弃并说清楚。
describe('注册表就绪', () => {
  const notReady = (processed: number, extra: Record<string, unknown> = {}): unknown => ({
    ok: false,
    error: 'registry_not_ready',
    code: 503,
    details: {
      ready: false,
      criterion: 'IsLoadingAssets',
      progress: {
        total: 1000,
        processed,
        pending_data_load: 0,
        discovering_files: false,
        snapshot_age_ms: 100,
        has_snapshot: true
      },
      ...extra
    }
  })
  const status = (ready: boolean, processed: number, snapshotAge = 100): unknown => ({
    ok: true,
    ready,
    criterion: 'IsLoadingAssets',
    progress: {
      total: 1000,
      processed,
      pending_data_load: 0,
      discovering_files: false,
      snapshot_age_ms: snapshotAge,
      has_snapshot: true
    }
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('等扫完再重发原命令，期间把进度推给界面', async () => {
    callRequest
      .mockResolvedValueOnce(notReady(100))
      .mockResolvedValueOnce(status(false, 500))
      .mockResolvedValueOnce(status(true, 1000))
      .mockResolvedValueOnce({ ok: true, result: 'done' })
    const updates: string[] = []

    const pending = callUeWhenRegistryReady<{ result: string }>(
      'content.naming_audit',
      { path: '/Game' },
      {
        timeoutMs: 180_000,
        ctx: { report: (p) => updates.push(p.text ?? '') },
        wait: { pollMs: 10 }
      }
    )
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending

    expect(result).toEqual({ ok: true, result: 'done' })
    expect(callRequest.mock.calls.map((c) => c[0])).toEqual([
      'content.naming_audit',
      'content.registry_status',
      'content.registry_status',
      'content.naming_audit'
    ])
    // 重发用的是同一份参数和超时
    expect(callRequest.mock.calls[3]).toEqual([
      'content.naming_audit',
      { path: '/Game' },
      'conn-1',
      180_000,
      // 第五个是中止信号。这条用例的 ctx 没带信号，所以是 undefined；
      // 真实运行时它就是本轮的信号，按停止时重发的那次会被当场作废
      undefined
    ])
    expect(updates[0]).toContain('已处理 100 / 约 1,000')
    expect(updates[1]).toContain('已处理 500 / 约 1,000')
  })

  it('取消就停，原命令不再发', async () => {
    callRequest.mockResolvedValueOnce(notReady(100)).mockResolvedValue(status(false, 200))
    const controller = new AbortController()

    const pending = callUeWhenRegistryReady(
      'content.naming_audit',
      {},
      {
        ctx: { report: () => {}, signal: controller.signal },
        wait: { pollMs: 10 }
      }
    ).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(25)
    controller.abort()
    await vi.advanceTimersByTimeAsync(25)
    const error = await pending

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('已取消')
    expect(callRequest.mock.calls.filter((c) => c[0] === 'content.naming_audit')).toHaveLength(1)
  })

  it('进度一直不动就放弃，并说清楚卡在哪', async () => {
    callRequest.mockResolvedValueOnce(notReady(300)).mockResolvedValue(status(false, 300))

    const pending = callUeWhenRegistryReady(
      'content.naming_audit',
      {},
      {
        wait: { pollMs: 10, stallMs: 50, maxWaitMs: 10_000 }
      }
    ).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(200)
    const error = await pending

    expect((error as Error).message).toContain('没动')
    expect((error as Error).message).toContain('300')
    expect(callRequest.mock.calls.filter((c) => c[0] === 'content.naming_audit')).toHaveLength(1)
  })

  it('等太久也放弃', async () => {
    let processed = 0
    callRequest.mockResolvedValueOnce(notReady(0)).mockImplementation(async () => {
      processed += 1
      return status(false, processed)
    })

    const pending = callUeWhenRegistryReady(
      'content.naming_audit',
      {},
      {
        wait: { pollMs: 10, stallMs: 10_000, maxWaitMs: 100 }
      }
    ).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(300)
    const error = await pending

    expect((error as Error).message).toContain('还没扫完')
  })

  it('defineUeTool 的工具自动拿到这层', async () => {
    callRequest
      .mockResolvedValueOnce(notReady(0))
      .mockResolvedValueOnce(status(true, 1000))
      .mockResolvedValueOnce({ ok: true, material_path: '/Game/M_A' })

    const pending = tool.execute('c1', { material_name: 'M_A' })
    await vi.advanceTimersByTimeAsync(2_500)
    const result = await pending

    expect(result.details).toEqual({ ok: true, material_path: '/Game/M_A' })
  })

  it('原样的 ok:false 仍然是失败，不会被当成 registry_not_ready', async () => {
    callRequest.mockResolvedValue({ ok: false, error: '路径不存在' })

    await expect(
      callUeWhenRegistryReady('content.naming_audit', {}, { wait: { pollMs: 10 } })
    ).rejects.toThrow('路径不存在')
    expect(callRequest).toHaveBeenCalledTimes(1)
  })
})
