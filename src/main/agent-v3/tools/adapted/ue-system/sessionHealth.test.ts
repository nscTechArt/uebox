/**
 * @vitest-environment node
 *
 * `ue_session_health` 的契约测试。
 *
 * 这个工具存在的全部理由是**分辨三件被同一句错误话糊在一起的事**：
 * 编辑器没在跑 / 在跑但没连上 / 连着。三种下一步完全相反，说错一种就把用户
 * 引到白费力气的方向去（最典型的：编辑器好好的，却被劝去重启编辑器）。
 *
 * 所以这里锁死的是**措辞**，不只是字段：字段对了但 summary 说错话，模型照样
 * 会照着 summary 干活。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface ProjectRow {
  connectionId: string
  projectName: string
  projectPath: string
  engineVersion: string
  isConnected: boolean
  /** 那头是不是一个能看能点的编辑器。缺省 true，见 `services/project/types.ts` */
  interactive?: boolean
}
interface ProcessRow {
  pid: number
  projectName: string
  projectPath: string
  engineVersion?: string
}

// vi.mock 的工厂会被提升到文件最顶部，先于普通 const 执行 ——
// 工厂里引用的 mock 必须用 vi.hoisted 声明，否则是 TDZ ReferenceError
const {
  getAllConnections,
  getAllProjects,
  getRunningProjects,
  getTargetConnectionId,
  getTargetProjectPath,
  recentEditorCrashes
} = vi.hoisted(() => ({
  recentEditorCrashes: vi.fn((): unknown[] => []),
  getAllConnections: vi.fn((): Array<{ id: string }> => []),
  getAllProjects: vi.fn((): ProjectRow[] => []),
  getRunningProjects: vi.fn((): ProcessRow[] => []),
  getTargetConnectionId: vi.fn((): string | undefined => undefined),
  getTargetProjectPath: vi.fn((): string | undefined => undefined)
}))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ getConnectionManager: () => ({ getAllConnections }) })
  }
}))

vi.mock('../../../../services/project', () => ({
  projectManager: {
    getAllProjects,
    // 和真实实现同源：连着、而且那头不是跑批的无头进程
    getInteractiveProjects: (): ProjectRow[] =>
      getAllProjects().filter((p) => p.isConnected && p.interactive !== false)
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => getTargetConnectionId(),
  getTargetProjectPath: () => getTargetProjectPath()
}))

vi.mock('../../../../utils/UnrealProcessDetector', () => ({
  default: { getRunningProjects: async () => getRunningProjects() }
}))

vi.mock('../../../../utils/UnrealPathManager', () => ({
  default: {
    isSourceBuildGUID: (value: string): boolean => /^\{[A-Fa-f0-9-]+\}$/.test(value),
    resolveEngineVersionFromGUID: async () => ({
      version: '5.4',
      engineRootPath: 'D:/UnrealEngine'
    })
  }
}))

vi.mock('../../../../services/editorCrashWatch/watch', () => ({
  recentEditorCrashes: () => recentEditorCrashes()
}))

import { createSessionHealthTool } from './sessionHealth'
import { HEALTH_SCOPE_FIELD, runWithRuntimeScope } from '../../../core/runtimeEnvelope'

type ToolResult = Record<string, unknown>

/**
 * 走的是 `defineTool` 包出来的那层，而不是直接调 spec.execute ——
 * `wait_seconds` 的默认值和上限是 Zod schema 声明的，绕过它就等于没测。
 */
async function run(input: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = createSessionHealthTool()
  const result = await tool.execute('call-1', input)
  return result.details as unknown as ToolResult
}

/** 模型实际看到的那段文本（summary 前面还有一行 state=） */
async function runText(input: Record<string, unknown> = {}): Promise<string> {
  const tool = createSessionHealthTool()
  const result = await tool.execute('call-1', input)
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

/** 一条握完手的连接：连接池和工程表里都得有，缺一边都不算连上 */
function connect(connectionId: string, projectPath: string, projectName = 'MyGame'): void {
  getAllConnections.mockReturnValue([{ id: connectionId }])
  getAllProjects.mockReturnValue([
    { connectionId, projectName, projectPath, engineVersion: '5.5', isConnected: true }
  ])
}

beforeEach(() => {
  getAllConnections.mockReturnValue([])
  getAllProjects.mockReturnValue([])
  getRunningProjects.mockReturnValue([])
  getTargetConnectionId.mockReturnValue(undefined)
  getTargetProjectPath.mockReturnValue(undefined)
  recentEditorCrashes.mockReturnValue([])
})

describe('三种状态各自的下一步', () => {
  it('macOS uses process detection without claiming it is Windows-only', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    try {
      const result = await run()
      expect(String(result.summary)).not.toContain('进程检测只在')
      expect(String(result.summary)).not.toContain('UnrealEditor.exe')
      expect(String(result.summary)).toContain('尚未识别到它打开的项目')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('一个进程都没有 → not_running，让用户打开工程', async () => {
    const result = await run()

    expect(result.success).toBe(true)
    expect(result.state).toBe('not_running')
    expect(String(result.summary)).toContain('编辑器没在跑')
    expect(String(result.summary)).toContain('打开工程')
  })

  /**
   * 这一条是最容易被说反的：编辑器好好的，问题在连接上。
   * 说成「重启编辑器」就是让用户白丢一次未保存的工作。
   */
  it('进程在、连接没有 → running_not_connected，让它等而不是重启', async () => {
    getRunningProjects.mockReturnValue([
      {
        pid: 22188,
        projectName: 'MyGame',
        projectPath: 'I:/Dev/MyGame/MyGame.uproject',
        engineVersion: '5.5'
      }
    ])

    const result = await run()

    expect(result.state).toBe('running_not_connected')
    const summary = String(result.summary)
    expect(summary).toContain('编辑器在跑')
    expect(summary).toContain('不要重启编辑器')
    expect(summary).toContain('wait_seconds')
    // 进程细节要在，用户/模型才对得上是哪一个编辑器
    expect(summary).toContain('22188')
    expect(summary).toContain('I:/Dev/MyGame/MyGame.uproject')
  })

  /**
   * 真机上踩过的那条死胡同：编辑器重启后还在加载工程，模型三秒内连探四次，
   * 然后把用户支去点「首页工程卡片 →「连接」」—— **那个按钮不存在**。
   *
   * 连接的方向是反的：盒子是被动的 WebSocket 服务端，插件每 5 秒自己重连
   * （UAL_NetworkManager.cpp 的 StartReconnectTimer），工程卡片上只有一个
   * 「已连接」标识。让用户去点一个不存在的按钮，等于把这一轮判死。
   */
  it('不把用户支去点一个不存在的「连接」按钮', async () => {
    getRunningProjects.mockReturnValue([
      { pid: 22188, projectName: 'MyGame', projectPath: 'I:/Dev/MyGame/MyGame.uproject' }
    ])

    const summary = String((await run()).summary)

    expect(summary).not.toContain('重新连接')
    expect(summary).toContain('没有连接按钮')
    expect(summary).toContain('用户不需要做任何操作')
    // 为什么现在还没连上，要给出那个真正常见的原因
    expect(summary).toContain('还在加载工程')
  })

  it('连上了 → connected，报出 connection_id、工程路径和引擎版本', async () => {
    connect('conn-1', 'I:/Dev/MyGame')
    getTargetConnectionId.mockReturnValue('conn-1')
    getRunningProjects.mockReturnValue([
      {
        pid: 22188,
        projectName: 'MyGame',
        projectPath: 'I:/Dev/MyGame/MyGame.uproject',
        engineVersion: '5.5'
      }
    ])

    const result = await run()

    expect(result.state).toBe('connected')
    expect(result.current_target_connection_id).toBe('conn-1')
    expect(result.connections).toEqual([
      {
        connection_id: 'conn-1',
        project_name: 'MyGame',
        project_path: 'I:/Dev/MyGame',
        engine_version: '5.5',
        is_current_target: true
      }
    ])
    const summary = String(result.summary)
    expect(summary).toContain('conn-1')
    expect(summary).toContain('5.5')
  })

  /**
   * 无头进程连着不算连着。
   *
   * 真机上的原始故障：用户把编辑器关了，一个 `-nullrhi -unattended` 的验证跑批
   * 跑完没退、还占着 17860 的连接。盒子照着连接列表告诉用户「现在连着的工程是
   * MetaHumanDoubaoFullDuplex」—— 那句话在当时就是假的，工程十分钟前就关了。
   *
   * 这个工具是模型核对连接状态的唯一入口，它要是把跑批进程算成一条连接，
   * 上面那句假话就会原样再说一遍。
   */
  it('只有无头跑批进程连着时，不算 connected', async () => {
    getAllConnections.mockReturnValue([{ id: 'conn-headless' }])
    getAllProjects.mockReturnValue([
      {
        connectionId: 'conn-headless',
        projectName: 'MyGame',
        projectPath: 'I:/Dev/MyGame',
        engineVersion: '5.5',
        isConnected: true,
        interactive: false
      }
    ])

    const result = await run()

    expect(result.state).not.toBe('connected')
    expect(result.connections).toEqual([])
  })
})

describe('进程和连接的对账', () => {
  /**
   * 连接侧报的是工程根目录，进程侧扫的是 `.uproject` 文件本身。
   * 不抹平这个差别，同一个编辑器会被同时报成「连着」和「没连上」。
   */
  it('工程目录和 .uproject 路径算同一个编辑器', async () => {
    connect('conn-1', 'I:/Dev/MyGame')
    getRunningProjects.mockReturnValue([
      {
        pid: 1,
        projectName: 'MyGame',
        projectPath: 'I:\\Dev\\MyGame\\MyGame.uproject',
        engineVersion: '5.5'
      }
    ])

    const result = await run()

    expect((result.editor_processes as EditorProcessShape[])[0].connected).toBe(true)
    expect(String(result.summary)).not.toContain('没连上盒子')
  })

  it('另一个没连上的编辑器单独列出来，并说明别去动它', async () => {
    connect('conn-1', 'I:/Dev/MyGame')
    getRunningProjects.mockReturnValue([
      { pid: 1, projectName: 'MyGame', projectPath: 'I:/Dev/MyGame/MyGame.uproject' },
      { pid: 2, projectName: 'Other', projectPath: 'I:/Dev/Other/Other.uproject' }
    ])

    const summary = String((await run()).summary)

    expect(summary).toContain('别去动它们')
    expect(summary).toContain('Other')
  })

  /**
   * 连接是活的就说明编辑器活着。进程扫不到多半是它不叫 UnrealEditor.exe，
   * 这时候要以连接为准 —— 反过来怀疑连接就会得出「没连上」的错误结论。
   */
  it('扫不到进程但连接是通的，以连接为准', async () => {
    connect('conn-1', 'I:/Dev/MyGame')

    const result = await run()

    expect(result.state).toBe('connected')
    expect(String(result.summary)).toContain('以连接为准')
  })

  it('自编译引擎的 GUID 还原成版本号，不向用户转述一串 GUID', async () => {
    getRunningProjects.mockReturnValue([
      {
        pid: 7,
        projectName: 'MyGame',
        projectPath: 'D:/Src/MyGame/MyGame.uproject',
        engineVersion: '{5A1B2C3D-0000-0000-0000-000000000000}'
      }
    ])

    const result = await run()

    expect((result.editor_processes as EditorProcessShape[])[0].engine_version).toBe('5.4')
  })
})

describe('这一轮绑的工程没连上', () => {
  /**
   * 会话挂在 MyGame 下、连着的却是 Other。不点破的话模型会拿旁边那条连接
   * 去干活 —— 那是「静默改错工程」，比报错糟糕得多。
   */
  it('别的工程连着不等于这条会话能干活', async () => {
    connect('conn-other', 'I:/Dev/Other', 'Other')
    getTargetConnectionId.mockReturnValue('conn-DEAD')
    getTargetProjectPath.mockReturnValue('I:/Dev/MyGame')

    const result = await run()

    expect(result.state).toBe('connected')
    expect(result.session_project_not_connected).toBe('I:/Dev/MyGame')
    const summary = String(result.summary)
    expect(summary).toContain('I:/Dev/MyGame')
    expect(summary).toContain('没有连接')
  })

  it('目标就是连着的那条时不报警', async () => {
    connect('conn-1', 'I:/Dev/MyGame')
    getTargetConnectionId.mockReturnValue('conn-1')
    getTargetProjectPath.mockReturnValue('I:/Dev/MyGame')

    const result = await run()

    expect(result.session_project_not_connected).toBeUndefined()
  })
})

/**
 * `projectManager` 会把断开的工程先标离线再删。只看 isConnected 的话，
 * 那段窗口期里工具会报「连着」，而命令发出去必然失败。
 */
it('已标离线但还没从连接池消失的记录不算连着', async () => {
  getAllConnections.mockReturnValue([])
  getAllProjects.mockReturnValue([
    {
      connectionId: 'conn-1',
      projectName: 'MyGame',
      projectPath: 'I:/Dev/MyGame',
      engineVersion: '5.5',
      isConnected: true
    }
  ])
  getRunningProjects.mockReturnValue([
    { pid: 1, projectName: 'MyGame', projectPath: 'I:/Dev/MyGame/MyGame.uproject' }
  ])

  const result = await run()

  expect(result.state).toBe('running_not_connected')
  expect(result.connections).toEqual([])
})

/**
 * 工具清单是每轮开始时定下来的（`resolveTools`），中途连上不会补发。
 * 不说这句的话，模型看到「已连接」就会去调一个它手上根本没有的工具，
 * 然后在「没有这个工具」和「重试」之间空转一整轮。
 */
it('连上了也要说清楚：这一轮的工具清单不会补发', async () => {
  connect('conn-1', 'I:/Dev/MyGame')

  expect(String((await run()).summary)).toContain('再发一条消息')
})

/** 没连上时同样要说 —— 那才是模型最容易拿「还是没连上」误判的时刻 */
it('没连上时也说清楚工具清单不会补发', async () => {
  getRunningProjects.mockReturnValue([
    { pid: 1, projectName: 'MyGame', projectPath: 'I:/Dev/MyGame/MyGame.uproject' }
  ])

  expect(String((await run()).summary)).toContain('再发一条消息')
})

/**
 * `state` 必须出现在**模型看得见的文本**里。
 *
 * details 不进上下文（见 `defineTool` 的说明），而 summary 是给人看的散文。
 * 三取一的那个值只藏在 details 里，等于模型拿不到它。
 */
it('state 进模型看得见的文本', async () => {
  connect('conn-1', 'I:/Dev/MyGame')

  expect(await runText()).toContain('state=connected')
})

/**
 * 等待。这是这个工具唯一能给出的「下一步」——
 * 编辑器重启后要先把工程加载完插件才起来，除了等没有别的办法，
 * 而几次空探不是等。
 */
describe('wait_seconds', () => {
  it('已经连着就立刻返回，不白等满', async () => {
    connect('conn-1', 'I:/Dev/MyGame')

    const startedAt = Date.now()
    const result = await run({ wait_seconds: 30 })

    expect(result.state).toBe('connected')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('等待期间连上就返回 connected', async () => {
    getRunningProjects.mockReturnValue([
      { pid: 1, projectName: 'MyGame', projectPath: 'I:/Dev/MyGame/MyGame.uproject' }
    ])
    // 第一次问还没连上，之后插件握上手了 —— 模拟编辑器加载完的那一刻
    let polls = 0
    getAllConnections.mockImplementation(() => (polls++ === 0 ? [] : [{ id: 'conn-1' }]))
    getAllProjects.mockReturnValue([
      {
        connectionId: 'conn-1',
        projectName: 'MyGame',
        projectPath: 'I:/Dev/MyGame',
        engineVersion: '5.5',
        isConnected: true
      }
    ])

    const result = await run({ wait_seconds: 2 })

    expect(result.state).toBe('connected')
    expect(polls).toBeGreaterThan(1)
  })

  it('等满了仍然没连上，如实报 running_not_connected 并说等了多久', async () => {
    getRunningProjects.mockReturnValue([
      { pid: 1, projectName: 'MyGame', projectPath: 'I:/Dev/MyGame/MyGame.uproject' }
    ])

    const result = await run({ wait_seconds: 1 })

    expect(result.state).toBe('running_not_connected')
    expect(result.waited_seconds).toBeGreaterThanOrEqual(1)
    expect(String(result.summary)).toContain('已经等了')
  })

  /**
   * 会话绑了工程时，「有连接」不等于「能干活」—— 旁边那个工程连着不算数。
   * 不区分的话等待会在错误的时刻结束，模型据此以为可以动手了。
   */
  it('绑了工程时，别的工程连着不算等到了', async () => {
    connect('conn-other', 'I:/Dev/Other', 'Other')
    getTargetConnectionId.mockReturnValue('conn-DEAD')
    getTargetProjectPath.mockReturnValue('I:/Dev/MyGame')

    const result = await run({ wait_seconds: 1 })

    expect(result.waited_seconds).toBeGreaterThanOrEqual(1)
    expect(result.session_project_not_connected).toBe('I:/Dev/MyGame')
  })
})

interface EditorProcessShape {
  pid: number
  project_name: string
  project_path: string
  engine_version?: string
  connected: boolean
}

/**
 * 作用域戳。
 *
 * 真机上这个工具最贵的一次代价不是它答错了，而是它**答对了然后被隔夜复用**：
 * 会话 cb5dedbe-974f-4995-b56d-af7646870188 里，前一天 22:13 的一条
 * `not_running` 留在历史里；次日 13:04 引擎早就连上了，模型照着那条旧结论
 * 对用户说「编辑器现在没跑」，然后连开二十多次 list_local_dir 扫磁盘。
 *
 * 戳解决的就是「模型凭什么知道这条结论是不是这一轮的」。
 */
describe('运行时作用域戳', () => {
  it('在作用域里跑时，戳进模型看得见的文本和 details', async () => {
    connect('conn-1', 'I:/Dev/MyGame')

    const text = await runWithRuntimeScope('rt-abc123', () => runText())
    const details = await runWithRuntimeScope('rt-abc123', () => run())

    expect(text).toContain(`${HEALTH_SCOPE_FIELD}=rt-abc123`)
    expect(details.runtime_scope_id).toBe('rt-abc123')
  })

  /**
   * 没有作用域（调试入口、对外的 MCP server）时写 `none` 而不是省略这一行。
   *
   * 省略的话模型分不清「这是旧格式」还是「这一轮没戳」；`none` 天然对不上
   * 任何信封，正好落在「不能当作当前状态」那一侧。
   */
  it('没有作用域时写 none，不省略也不印 undefined', async () => {
    connect('conn-1', 'I:/Dev/MyGame')

    const text = await runText()

    expect(text).toContain(`${HEALTH_SCOPE_FIELD}=none`)
    expect(text).not.toContain('undefined')
  })

  it('三种状态都带戳 —— 没连上时那条最容易被隔夜复用', async () => {
    const notRunning = await runWithRuntimeScope('rt-1', () => runText())
    expect(notRunning).toContain('state=not_running')
    expect(notRunning).toContain(`${HEALTH_SCOPE_FIELD}=rt-1`)

    getRunningProjects.mockReturnValue([
      { pid: 1, projectName: 'MyGame', projectPath: 'I:/Dev/MyGame/MyGame.uproject' }
    ])
    const running = await runWithRuntimeScope('rt-2', () => runText())
    expect(running).toContain('state=running_not_connected')
    expect(running).toContain(`${HEALTH_SCOPE_FIELD}=rt-2`)
  })

  // 结论自己要声明保质期 —— 光有戳而不说「过期了别用」，模型照样会用
  it('每种状态的 summary 都说清这只代表这一轮', async () => {
    const notRunning = String((await run()).summary)
    expect(notRunning).toContain('只代表')
    expect(notRunning).toContain('runtime-status')

    connect('conn-1', 'I:/Dev/MyGame')
    const connected = String((await run()).summary)
    expect(connected).toContain('只代表')
    expect(connected).toContain('runtime-status')
  })
})

/**
 * 编辑器刚崩完、盒子正在重开时，下一步同样是「等」—— 但模型必须知道是崩了：
 * 连上之后不能拿同样的参数把刚才那一步再跑一遍。
 */
describe('最近的崩溃', () => {
  const crash = {
    editor: {
      connectionId: 'c',
      projectName: 'MyGame',
      projectDir: 'I:/Dev/MyGame',
      connectedAt: 0
    },
    report: {
      folder: 'x',
      crashType: 'Crash',
      errorMessage: 'EXCEPTION_ACCESS_VIOLATION',
      callStackHead: '',
      time: 0
    },
    reporterClosed: true,
    restore: {
      backupDir: 'I:/Dev/MyGame/Saved/UEBoxCrashRecovery/1',
      packageCount: 1,
      missingFiles: []
    },
    relaunch: 'relaunched',
    at: Date.now() - 30_000
  }

  it('放在 summary 最前面，带原因、重开结果、存档备份和别原样重试', async () => {
    recentEditorCrashes.mockReturnValue([crash])
    const result = await run()
    const summary = String(result.summary)

    expect(summary.startsWith('**最近有编辑器崩溃')).toBe(true)
    expect(summary).toContain('EXCEPTION_ACCESS_VIOLATION')
    expect(summary).toContain('自动重开了它')
    expect(summary).toContain('UEBoxCrashRecovery')
    expect(summary).toContain('不要用同样的参数重试')
    expect(result.recent_crashes).toMatchObject([
      { project_name: 'MyGame', relaunch: 'relaunched' }
    ])
  })

  it('这一轮绑了别的工程时不报这条', async () => {
    recentEditorCrashes.mockReturnValue([crash])
    getTargetProjectPath.mockReturnValue('I:/Dev/Other/Other.uproject')
    const result = await run()
    expect(result.recent_crashes).toBeUndefined()
  })
})
