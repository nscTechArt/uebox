/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 已连接工程表。测试靠改它来模拟「编辑器起来了」 */
const projects: Array<{
  connectionId: string
  projectPath: string
  isConnected: boolean
  interactive?: boolean
}> = []

/** 探针（`system.get_project_info`）这一次该怎么回。默认成功 */
let probe: () => unknown = () => ({ projectName: 'New' })
const probeCalls: string[] = []

vi.mock('../../../../services/project/projectManager', () => ({
  projectManager: {
    getProject: (id: string) => projects.find((p) => p.connectionId === id),
    getAllProjects: () => projects,
    getInteractiveProjects: () => projects.filter((p) => p.isConnected && p.interactive !== false)
  }
}))

vi.mock('../../../../services/project', () => ({
  projectManager: {
    getProject: (id: string) => projects.find((p) => p.connectionId === id),
    getAllProjects: () => projects,
    getInteractiveProjects: () => projects.filter((p) => p.isConnected && p.interactive !== false)
  }
}))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({
      callRequest: async (_method: string, _payload: unknown, connectionId: string) => {
        probeCalls.push(connectionId)
        return probe()
      }
    })
  }
}))

import { runWithTargetConnectionId } from '../../../core/projectTargetContext'
import { __resetSessionBindingsForTest, setSessionBinding } from '../../../core/sessionBinding'
import { awaitProjectLive } from './awaitProjectLive'

/** 钉在 A 工程上的那条会话。归属在表里，执行流只带这个 id */
const SCOPED_SESSION = 's-scoped'

beforeEach(() => {
  projects.length = 0
  probeCalls.length = 0
  __resetSessionBindingsForTest()
  setSessionBinding(SCOPED_SESSION, { projectName: 'A', projectPath: 'I:/Dev/A' })
  probe = () => ({ projectName: 'New' })
})

/**
 * 「工程打开了」和「工程能干活了」之间那段空白，以前是让用户来填的。
 *
 * 真机上那一幕：模型建好新工程、把它打开、编辑器跑起来了，然后对用户说
 * 「请你在盒子界面上把当前工程切到新工程，或者再发一条消息」。用户一个字的
 * 信息都补不了 —— 是工具自己打开的工程，路径是工具自己给的参数。
 */
describe('awaitProjectLive', () => {
  it('默认调用在工程仍加载时立即返回，不占用 MCP 的 30 秒窗口', async () => {
    vi.useFakeTimers()
    try {
      const result = await awaitProjectLive({ projectPath: 'I:/Dev/New' })
      expect(result.live).toBe(false)
      expect(result.waitedMs).toBe(0)
      expect(probeCalls).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('工程已经连着时：探针跑通才算数，并把这一轮切过去', async () => {
    projects.push({ connectionId: 'conn-old', projectPath: 'I:/Dev/Old', isConnected: true })
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })

    const result = await runWithTargetConnectionId(
      { connectionId: 'conn-old', projectPath: 'I:/Dev/Old' },
      () => awaitProjectLive({ projectPath: 'I:/Dev/New', timeoutMs: 5_000 })
    )

    expect(result.live).toBe(true)
    expect(result.connectionId).toBe('conn-new')
    expect(result.retargeted).toBe(true)
    // 探针必须发在**新**连接上：发在旧的上面只能证明旧工程还活着
    expect(probeCalls).toEqual(['conn-new'])
  })

  /**
   * 连上不等于能干活。`ue-editor/editorLifecycle.ts` 就在这里出过事：
   * 只看连接数和记录在不在就报成功，紧接着每条引擎命令都回「客户端已断开」。
   * 不回读校验的「成功」等于没有成功。
   */
  it('连着但探针不通时不报 live —— 不谎报成功', async () => {
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })
    probe = () => {
      throw new Error('客户端不存在或已断开')
    }

    /*
     * 预算要够第一轮真发出一条探针。
     *
     * 0 会让探针整个跳过（那是 `waitSeconds: 0` 那条路），而 1ms 在机器忙的时候
     * 会在算 `remaining` 之前就过期 —— 同一条用例时好时坏。给 200ms：第一轮必探，
     * 探完（立刻抛）睡一秒，第二轮预算用完退出，稳定复现「探了、没通」。
     */
    const result = await runWithTargetConnectionId({}, () =>
      awaitProjectLive({ projectPath: 'I:/Dev/New', timeoutMs: 200 })
    )

    expect(result.live).toBe(false)
    // 报的是探针那次的真实原因，不是「预算用完了」——
    // 后者对排查没有任何帮助，而用户拿到的就是这句话
    expect(result.lastError).toContain('客户端不存在或已断开')
    /*
     * 切还是切了 —— 切了就是切了，如实回报。
     *
     * 收回去反而更糟：那样这一轮剩下的命令会重新发往旧工程，在用户根本没打算
     * 动的工程上悄悄生效。发给新工程发失败会当场报错，那是能看见的失败。
     */
    expect(result.retargeted).toBe(true)
    /*
     * 探过、失败了 —— 和「预算不够没来得及探」必须分得开。
     *
     * 混成一句的话，一个卡在编译着色器上、连着但一直不回话的编辑器会被
     * `handOffToOpenedProject` 报成「连着，只是这次没验，直接接着干」，
     * 于是模型对着一个死掉的游戏线程继续发命令。
     */
    expect(result.probeFailed).toBe(true)
    expect(result.connectionSeen).toBe(true)
  })

  // 预算为零时一条都没探过：可以说「只是没验」，不能说「它不回话」
  it('零预算时 probeFailed 为 false —— 没探过不等于探失败了', async () => {
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })

    const result = await runWithTargetConnectionId({}, () =>
      awaitProjectLive({ projectPath: 'I:/Dev/New', timeoutMs: 0 })
    )

    expect(result.connectionSeen).toBe(true)
    expect(result.probeFailed).toBe(false)
  })

  /**
   * 本来就指着这个工程时也算「切过去了」。
   *
   * `retargeted` 回答的是「命令现在发往这个工程了吗」，不是「连接 id 变了吗」。
   * 按后者算的话，模型不知道工程已经开着、又调了一次 `open_project`，
   * 会拿到 `switched_target: false`，然后照着工具描述反推出「没切过去」，
   * 去说那句这套机制专门要消灭的「请你在界面上把当前工程切过去」。
   */
  it('目标本来就是这个工程时，仍然报 retargeted', async () => {
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })

    const result = await runWithTargetConnectionId(
      { connectionId: 'conn-new', projectPath: 'I:/Dev/New' },
      () => awaitProjectLive({ projectPath: 'I:/Dev/New', timeoutMs: 5_000 })
    )

    expect(result.live).toBe(true)
    expect(result.retargeted).toBe(true)
  })

  it('还没连上就等到超时，如实说等了多久、卡在哪', async () => {
    const result = await runWithTargetConnectionId({}, () =>
      awaitProjectLive({ projectPath: 'I:/Dev/New', timeoutMs: 0 })
    )

    expect(result.live).toBe(false)
    expect(result.retargeted).toBe(false)
    expect(result.lastError).toContain('编辑器可能还在启动')
  })

  /**
   * `waitSeconds: 0` 的 schema 上写着「立刻返回」，那就必须真的立刻。
   *
   * 以前 deadline 只在一轮跑完之后才看，于是零预算照样会撞进一次 15 秒的探针 ——
   * 工程连着但游戏线程正在编译着色器时，用户会盯着一个说好「立刻返回」的调用
   * 转十五秒。现在剩余预算为零就不发探针。
   */
  it('零预算时一条探针都不发', async () => {
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })

    const result = await runWithTargetConnectionId({}, () =>
      awaitProjectLive({ projectPath: 'I:/Dev/New', timeoutMs: 0 })
    )

    expect(probeCalls).toEqual([])
    expect(result.live).toBe(false)
  })

  /**
   * 会话被用户归到别的工程下时**立刻返回**，不空等三分钟。
   *
   * 等到了也用不了它 —— 这一轮的引擎工具是按归属工程注册的。早点把原因说给
   * 用户听，比让他盯着一个转三分钟的工具调用强。
   */
  it('会话钉在别的工程上时立刻返回，不空等', async () => {
    projects.push({ connectionId: 'conn-a', projectPath: 'I:/Dev/A', isConnected: true })

    const started = Date.now()
    const result = await runWithTargetConnectionId(
      // 归属住在 `sessionBinding` 那张表里，执行流只带 sessionId 过去查
      { connectionId: 'conn-a', projectPath: 'I:/Dev/A', sessionId: SCOPED_SESSION },
      () => awaitProjectLive({ projectPath: 'I:/Dev/B', timeoutMs: 60_000 })
    )

    expect(result.retargetBlocked).toBe('session-scoped')
    expect(result.sessionProjectPath).toBe('I:/Dev/A')
    expect(result.retargeted).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(probeCalls).toEqual([])
  })

  // 用户按停止时当场收手，不再空转到超时
  it('中止信号一到就返回', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runWithTargetConnectionId({}, () =>
      awaitProjectLive({
        projectPath: 'I:/Dev/New',
        timeoutMs: 60_000,
        signal: controller.signal
      })
    )

    expect(result.live).toBe(false)
    expect(result.lastError).toBe('已被中止')
  })

  /*
   * 无头跑、外部 MCP 调用这些路径没有「这一轮的目标」可切。那不是错 ——
   * 底层按「不指定」处理。照样等它连上、照样回读校验，只是不报 retargeted。
   */
  it('不在执行流上下文里时照样等、照样校验，只是不报切换', async () => {
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })

    const result = await awaitProjectLive({ projectPath: 'I:/Dev/New', timeoutMs: 5_000 })

    expect(result.live).toBe(true)
    expect(result.retargeted).toBe(false)
    expect(result.retargetBlocked).toBe('no-context')
    expect(probeCalls).toEqual(['conn-new'])
  })
})
