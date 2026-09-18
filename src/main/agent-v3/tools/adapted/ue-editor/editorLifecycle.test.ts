/**
 * @vitest-environment node
 *
 * 编辑器生命周期工具的契约测试。
 *
 * 重启是这里唯一一个**会掐断自己连接**的工具，它的等待逻辑有两个很容易写错的
 * 地方，各有一组用例盯着：
 *
 *   1. 重启是异步的（插件先回响应、下一帧才退进程），所以不能直接等重连 ——
 *      那会立刻看到重启**之前**还活着的那条连接，马上报「已恢复」。
 *      必须先等断开、再等重连。
 *   2. 连上 ≠ 能干活。只看连接数和项目记录就报 `reconnected: true`，
 *      现场表现是重启报成功、紧接着每条引擎命令都回「客户端不存在或已断开」。
 *      **必须真发一条只读命令回读校验过**才敢报成功。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

/**
 * 目标连接是**有状态**的：`setTargetConnectionId` 之后 `getTargetConnectionId`
 * 就该读到新值（生产实现改的是 AsyncLocalStorage 里同一个 store 对象）。
 *
 * 用常量 mock 的话，「回读探针发往了哪条连接」这件事根本测不出来 ——
 * 而探针发到旧的那条死连接上，正是这个工具出过的事故本身。
 */
let targetConnectionId: string | undefined = 'conn-1'

const setTargetConnectionId = vi.fn((id: string): boolean => {
  targetConnectionId = id
  return true
})

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => targetConnectionId,
  setTargetConnectionId: (id: string) => setTargetConnectionId(id)
}))

/** 断开时旧记录被整条删掉，重连后是新 id —— 用这两个 mock 复现这条时间线 */
const getProject = vi.fn<(id: string) => { projectPath?: string } | undefined>()
const getConnectionIdByPath = vi.fn<(path: string) => string | undefined>()

vi.mock('../../../../services/project', () => ({
  projectManager: {
    getProject: (id: string) => getProject(id),
    getConnectionIdByPath: (path: string) => getConnectionIdByPath(path)
  }
}))

import {
  createRestartEditorTool,
  createCollectGarbageTool,
  createFixupRedirectorsTool
} from './editorLifecycle'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const exec = (factory: () => unknown, input: unknown = {}): Promise<ToolResult> =>
  (factory() as unknown as Executable).execute(input)

/** 插件在有未保存改动时回的形状 */
const REFUSAL = {
  ok: false,
  __rpc: { code: 409 },
  details: { unsaved: ['/Game/A', '/Game/B'], unsaved_count: 2 }
}

/** 重连之后用来回读校验的只读命令，插件一定有 */
const PROBE_METHOD = 'system.get_project_info'

/**
 * 按方法名分发：重启命令和回读探针走的是同一个 `callRequest`。
 *
 * 用一个 `mockResolvedValue` 糊住两者的话，探针会跟着重启命令一起「成功」，
 * 于是最该测的那条路径（重启了但连不上）根本走不到。
 */
function routeCalls(options: { probeRejects?: string; probeReturns?: unknown } = {}): void {
  callRequest.mockImplementation(async (method: string) => {
    if (method === 'editor.restart') return { ok: true, restarting: true }
    if (method === PROBE_METHOD) {
      if (options.probeRejects) throw new Error(options.probeRejects)
      return 'probeReturns' in options ? options.probeReturns : { ok: true, project_name: 'Demo' }
    }
    throw new Error(`未预期的命令: ${method}`)
  })
}

/** 探针实际发往了哪条连接 —— 发到旧的那条死连接上就是事故复现 */
function probeTargets(): unknown[] {
  return callRequest.mock.calls
    .filter((call) => call[0] === PROBE_METHOD)
    .map((call) => call[2] as unknown)
}

/**
 * 让连接数按脚本变化，模拟「还连着 → 断了 → 回来了」。
 *
 * 用假定时器跑，否则这几条要真等好几秒。
 */
function scriptConnectionCounts(sequence: number[]): void {
  let index = 0
  getConnectionCount.mockImplementation(() => {
    const value = sequence[Math.min(index, sequence.length - 1)]
    index += 1
    return value
  })
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset()
  getConnectionCount.mockReturnValue(1)
  setTargetConnectionId.mockClear()
  targetConnectionId = 'conn-1'
  getProject.mockReset()
  getProject.mockReturnValue({ projectPath: 'H:/Proj/Demo.uproject' })
  getConnectionIdByPath.mockReset()
  getConnectionIdByPath.mockReturnValue('conn-2')
  vi.useRealTimers()
})

describe('ue_restart_editor', () => {
  it('有未保存改动时翻译成「先去保存」，不推荐 force', async () => {
    callRequest.mockResolvedValue(REFUSAL)

    const result = await exec(createRestartEditorTool, {})

    expect(result.success).toBe(false)
    expect(result.needs_save_first).toBe(true)
    const message = String(result.error)
    expect(message).toContain('ue_save')
    expect(message).toContain('/Game/A')
    expect(message).toContain('无法撤销')
  })

  /**
   * 这条是这个文件里最重要的测试。
   *
   * 连接数脚本：第一次查还连着（重启尚未生效），之后断开，最后恢复。
   * 实现要是跳过「等断开」这一步，会在第一次查询就看到 >0 而报成功。
   */
  it('先等断开再等重连 —— 不能被重启前那条还活着的连接骗过去', async () => {
    routeCalls()
    // 1 = 还连着（重启还没生效）, 0 = 断了, 1... = 回来了
    scriptConnectionCounts([1, 1, 0, 0, 1])

    const result = await exec(createRestartEditorTool, { timeout_seconds: 30 })

    expect(result.success).toBe(true)
    expect(result.restarted).toBe(true)
    expect(result.reconnected).toBe(true)
  }, 30000)

  /**
   * 连接一直没断 = 重启大概率压根没发生（比如插件版本旧、没有这个命令）。
   * 这种情况必须报失败，不能因为"连接是好的"就当成功。
   */
  it('连接始终没断开时报失败，并指出可能没真的重启', async () => {
    routeCalls()
    getConnectionCount.mockReturnValue(1)

    const result = await exec(createRestartEditorTool, { timeout_seconds: 1 })

    expect(result.success).toBe(false)
    expect(result.restarted).toBe(false)
    expect(result.timed_out).toBe(true)
    expect(String(result.error)).toContain('没有断开')
  }, 20000)

  /**
   * 断开了但没等到回来：**不能**说成"重启失败"。
   *
   * 大工程启动就是慢。说成失败的话，模型下一步很可能再重启一次 ——
   * 而那时编辑器正在起，二次重启才是真的坏事。
   */
  it('超时的措辞要留出「只是还没起完」的可能', async () => {
    routeCalls()
    // 第一次查是发命令前的连接检查，必须还连着；之后一直是 0（关掉了没回来）。
    // 一开始就给 0 的话，工具在 requireConnection 那步就先回「没有连接」了，
    // 根本走不到等待逻辑。
    scriptConnectionCounts([1, 0])

    const result = await exec(createRestartEditorTool, { timeout_seconds: 1 })

    expect(result.success).toBe(false)
    // 断开这件事是确凿的 —— 重启发生了，只是没等到它回来
    expect(result.restarted).toBe(true)
    expect(result.reconnected).toBe(false)
    expect(result.timed_out).toBe(true)
    const message = String(result.error)
    expect(message).toContain('不一定是失败')
    expect(message).toContain('ue_get_current_level')
  }, 20000)

  /**
   * 重启之后连接是**新的一条**（旧记录断开时就被删了）。这一轮的目标 id
   * 还停在旧的那个上，不换的话后面每条引擎命令都回「客户端不存在或已断开」——
   * 现场表现就是重启工具报 reconnected: true，紧接着所有命令全挂。
   */
  it('重连后把执行流的目标切到新的 connectionId 上', async () => {
    routeCalls()
    scriptConnectionCounts([1, 1, 0, 0, 1])

    const result = await exec(createRestartEditorTool, { timeout_seconds: 30 })

    expect(result.success).toBe(true)
    // 重启前抓路径，靠它认出重连回来的是同一个工程
    expect(getProject).toHaveBeenCalledWith('conn-1')
    expect(getConnectionIdByPath).toHaveBeenCalledWith('H:/Proj/Demo.uproject')
    expect(setTargetConnectionId).toHaveBeenCalledWith('conn-2')
  }, 30000)

  /**
   * 报成功之前必须**真发一条只读命令**并收到响应。
   *
   * 只看连接数和项目记录都不算数：那两样只说明「有个 socket 连着」，
   * 不说明这条连接能把命令送到插件手里。而且探针必须发往**新**连接 ——
   * 发给旧的那个死 id，它只会回「客户端不存在或已断开」。
   */
  it('报成功之前先在新连接上跑通一次只读命令', async () => {
    routeCalls()
    scriptConnectionCounts([1, 1, 0, 0, 1])

    const result = await exec(createRestartEditorTool, { timeout_seconds: 30 })

    expect(result.success).toBe(true)
    expect(probeTargets()).toEqual(['conn-2'])
  }, 30000)

  /**
   * 这条盯的是这个工具真出过的事故：重启返回 `reconnected: true`，
   * 紧接着 pcg_status / ue_get_project_info / ue_get_current_level 全部回
   * 「客户端不存在或已断开」，直到用户手动在界面里重新连接项目才恢复。
   *
   * socket 回来了、记录也认回来了，但命令送不到 —— 这时候只能如实说没连上。
   * 报一个后续会连环失败的 true，比报失败坏得多：模型会照着那个 true 一路走下去，
   * 而每一步的失败信息指的都不是根因。
   */
  it('socket 回来了但命令跑不通时，如实报「重启了、没连上」并让用户去界面重连', async () => {
    routeCalls({ probeRejects: '客户端不存在或已断开: conn-2' })
    scriptConnectionCounts([1, 1, 0, 0, 1])

    // 回读校验的余量是固定的 60 秒，用假定时器快进，别真等
    vi.useFakeTimers()
    const pending = exec(createRestartEditorTool, { timeout_seconds: 30 })
    await vi.advanceTimersByTimeAsync(120_000)
    const result = await pending
    vi.useRealTimers()

    expect(result.success).toBe(false)
    expect(result.restarted).toBe(true)
    expect(result.reconnected).toBe(false)
    expect(result.needs_manual_reconnect).toBe(true)
    const message = String(result.error)
    expect(message).toContain('重新连接项目')
    expect(message).toContain('不要重复重启')
    // 失败原因要带上，否则用户只能猜
    expect(message).toContain('客户端不存在或已断开')
  })

  /**
   * socket 连上 ≠ 能干活：插件还要握手、把工程信息报上来。
   * 这段时间里拿不到新 id，报成功的话模型下一条命令必然失败。
   *
   * 注意这时候**不该**去发探针：目标还指着重启前那个死 id，
   * 发出去必然失败，而且会给出一条误导人的失败原因。
   */
  it('插件没握手完就不报成功，也不拿旧连接去试探', async () => {
    routeCalls()
    scriptConnectionCounts([1, 1, 0, 0, 1])
    getConnectionIdByPath.mockReturnValue(undefined)

    vi.useFakeTimers()
    const pending = exec(createRestartEditorTool, { timeout_seconds: 30 })
    await vi.advanceTimersByTimeAsync(120_000)
    const result = await pending
    vi.useRealTimers()

    expect(result.success).toBe(false)
    expect(result.restarted).toBe(true)
    expect(result.reconnected).toBe(false)
    expect(result.timed_out).toBe(true)
    expect(String(result.error)).toContain('不要重复重启')
    expect(setTargetConnectionId).not.toHaveBeenCalled()
    expect(probeTargets()).toEqual([])
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await exec(createRestartEditorTool, {})

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('ue_collect_garbage', () => {
  it('回收前后的数字原样带上', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      objects_before: 500000,
      objects_after: 420000,
      objects_freed: 80000,
      mb_before: 12000,
      mb_after: 9000,
      mb_freed: 3000,
      elapsed_ms: 2400
    })

    const result = await exec(createCollectGarbageTool, {})

    expect(result.objects_freed).toBe(80000)
    expect(String(result.summary)).toContain('80000 个对象')
    expect(String(result.summary)).toContain('3000 MB')
  })

  /**
   * 内存不降是常见情况（回收本身要分配、其他线程也在动）。
   * 这时候不能显示「释放 0 MB」让人以为白跑了 —— objects_freed 才是实绩。
   */
  it('内存没降时说清楚，而不是报「释放 0 MB」', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      objects_before: 500000,
      objects_after: 480000,
      objects_freed: 20000,
      mb_before: 12000,
      mb_after: 12000,
      mb_freed: 0,
      elapsed_ms: 900
    })

    const result = await exec(createCollectGarbageTool, {})

    expect(String(result.summary)).toContain('20000 个对象')
    expect(String(result.summary)).toContain('没有明显下降')
  })
})

describe('ue_fixup_redirectors', () => {
  it('dry_run 时明确说没有改动任何东西', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 12,
      fixed: 0,
      dry_run: true,
      redirectors: ['/Game/Old/A', '/Game/Old/B']
    })

    const result = await exec(createFixupRedirectorsTool, { dry_run: true })

    expect(result.success).toBe(true)
    expect(result.found).toBe(12)
    expect(String(result.summary)).toContain('没有改动')
  })

  /**
   * 改引用会把引用者标脏。不提醒的话，调用方以为清理完就结束了，
   * 而那些重写过的引用其实还在内存里没落盘 —— 关掉编辑器就白干了。
   */
  it('清理完要报出待保存的包数', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 12,
      fixed: 12,
      remaining: 0,
      dry_run: false,
      dirty_after: 34,
      redirectors: [],
      note: 'Rewrote referencers...'
    })

    const result = await exec(createFixupRedirectorsTool, {})

    expect(result.dirty_after).toBe(34)
    expect(String(result.summary)).toContain('12/12')
    expect(String(result.summary)).toContain('34 个包待保存')
  })

  it('一个都没有时算成功', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 0,
      fixed: 0,
      dry_run: false,
      redirectors: [],
      note: 'No redirectors found - nothing to clean up.'
    })

    const result = await exec(createFixupRedirectorsTool, {})

    expect(result.success).toBe(true)
    expect(result.found).toBe(0)
  })

  it('部分清不掉时把剩余数带上', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      path: '/Game',
      found: 10,
      fixed: 7,
      remaining: 3,
      dry_run: false,
      dirty_after: 5,
      redirectors: []
    })

    const result = await exec(createFixupRedirectorsTool, {})

    expect(result.remaining).toBe(3)
    expect(String(result.summary)).toContain('7/10')
  })
})
