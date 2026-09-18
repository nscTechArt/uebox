/** @vitest-environment node */
/**
 * 主进程这边「这一轮该操作哪个工程」的四个零件。
 *
 * 它们此前一条测试都没有，而正是这个缺口让两个真 bug 溜了过去：
 *
 *   - 轮内重新体检引擎时用的是**收到消息那一刻**的归属快照，于是模型自己改完
 *     归属之后，工具清单和 `<environment>` 永远停在旧工程上；
 *   - 新归属只写了盘，没改内存里那份执行选项，`/goal` 的状态机下一步就把它盖回去。
 *
 * 两条都不报错，只会让模型对着一个工程说话、在另一个工程上动手。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ProjectRow = {
  connectionId: string
  projectName: string
  projectPath: string
  connectedAt: number
  isConnected?: boolean
  interactive?: boolean
}

const mock = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  interactive: [] as ProjectRow[],
  /** 库里登记过的工程。计数用来验「稳态下不读库」 */
  library: [] as Array<{ projectName: string; projectPath: string; EngineAssociation: string }>,
  libraryReads: 0,
  socketCount: 0,
  rebound: undefined as unknown,
  targetId: undefined as string | undefined,
  saveOptions: vi.fn(),
  loadOptions: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: unknown) => mock.handlers.set(name, handler) },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../agent-v3/core/promptAttachments', () => ({
  savePromptAttachments: async () => [],
  formatAttachmentBlock: () => ''
}))
vi.mock('../agent-v3/smoke', () => ({}))
// 摊原模块再覆盖：`normalizeProjectPath` 这类纯函数保持真实行为，
// 新增导出自动带上 —— 手抄的那一份已经在三个套件里长出过两种行为
vi.mock('../agent-v3/core/projectTargetContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithTargetConnectionId: (_target: unknown, run: () => unknown) => run(),
  getTargetConnectionId: () => mock.targetId,
  getReboundSessionProject: () => mock.rebound
}))
vi.mock('../agent-v3/core/assetLock', () => ({
  setLockConflictNotifier: () => {},
  setLockChangeListener: () => {},
  setLockReleaseListener: () => {},
  releaseAll: () => {},
  runWithLockOwner: (_id: string, run: () => unknown) => run()
}))
vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: () => ({}) }))
vi.mock('../sqliteDataBase/models/project', () => ({
  getAllProjects: () => {
    mock.libraryReads += 1
    return mock.library
  }
}))
vi.mock('../services/project/projectManager', () => ({
  projectManager: {
    getInteractiveProjects: () => mock.interactive,
    getCurrentProject: () => [...mock.interactive].sort((a, b) => b.connectedAt - a.connectedAt)[0],
    getProject: (id: string) => mock.interactive.find((item) => item.connectionId === id),
    getNonInteractiveProjects: () => []
  }
}))
vi.mock('../agent-v3/toolDiagnostics', () => ({}))
vi.mock('../agent-v3/tools/builtin/localShell', () => ({ isShellAvailable: async () => true }))
vi.mock('../agent-v3/capabilities/mcp', () => ({
  ensureConnected: async () => ({ getTools: () => [], getStatuses: () => [] })
}))
vi.mock('../agent-v3/capabilities/mcp/hostStore', () => ({}))
vi.mock('../agent-v3/tools/registry', () => ({}))
vi.mock('../agent-v3/core/assetSnapshot', () => ({}))
vi.mock('../agent-v3/core/openAsset', () => ({}))
vi.mock('../agent-v3/core/reviewChanges', () => ({}))
vi.mock('../agent-v3/capabilities/plugins/registry', () => ({}))
vi.mock('../agent-v3/core/createAgent', () => ({
  createUnrealAgent: vi.fn(),
  runSubAgent: vi.fn()
}))
vi.mock('../agent-v3/host/eventBridge', () => ({ createEventBridge: () => () => {} }))
vi.mock('../agent-v3/host/approvalChannel', () => ({
  createApprovalRequester: () => async () => 'approve'
}))
vi.mock('../agent-v3/host/questionChannel', () => ({
  createQuestionRequester: () => async () => ({})
}))
vi.mock('../agent-v3/core/streamFn', () => ({ resolveAgentModel: vi.fn() }))
vi.mock('../agent-v3/core/compaction', () => ({
  compactMessages: vi.fn(),
  measureCompaction: () => ({ tokensBefore: 0, tokensAfter: 0, saved: 0 })
}))
vi.mock('../agent-v3/core/compactionCheckpoint', () => ({ deleteCheckpoint: vi.fn() }))
vi.mock('../agent-v3/core/transcriptStore', () => ({
  TranscriptStore: class {
    markPersisted = vi.fn()
    append = vi.fn()
    discard = async (): Promise<void> => {}
  },
  loadTranscript: vi.fn(),
  truncateTranscript: vi.fn(),
  forkTranscript: vi.fn(),
  deleteTranscript: vi.fn()
}))
vi.mock('../agent-v3/core/sessionExecutionOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-v3/core/sessionExecutionOptions')>()),
  saveExecutionOptions: mock.saveOptions,
  loadExecutionOptions: mock.loadOptions,
  deleteExecutionOptions: async () => {},
  copyExecutionOptions: async () => {}
}))
vi.mock('../agent-v3/host/runObserver', () => ({ notifyAgentRun: () => {} }))
vi.mock('./realtimeVoice', () => ({ isVoiceTaskSession: () => false }))
vi.mock('../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({
      getConnectionCount: () => mock.socketCount,
      callRequest: async () => ({})
    })
  }
}))
vi.mock('../agent-v3/capabilities/skills', () => ({}))

import {
  createEngineRefresher,
  currentProjectForFlow,
  persistSessionProject,
  savedBindingSeed,
  sessionProjectCandidates
} from './agentV3'
import { resolveSessionScope, type SessionProjectScope } from '../agent-v3/core/sessionScope'
// 归属现在只有一个来源：那张表。`createEngineRefresher` 不再收快照参数，
// 所以这些用例得把归属真的写进表里，而不是靠传参
import { __resetSessionBindingsForTest, setSessionBinding } from '../agent-v3/core/sessionBinding'
import type { SessionExecutionOptions } from '../agent-v3/core/sessionExecutionOptions'

const A: ProjectRow = {
  connectionId: 'conn-a',
  projectName: 'GameA',
  projectPath: 'D:/Games/GameA',
  connectedAt: 1,
  isConnected: true
}
const B: ProjectRow = {
  connectionId: 'conn-b',
  projectName: 'GameB',
  projectPath: 'D:/Games/GameB',
  connectedAt: 2,
  isConnected: true
}

/** 用真实的 resolveSessionScope 算一份初始作用域，和被测代码同源 */
function scopeOf(stamp: { projectName: string; projectPath?: string } | null): SessionProjectScope {
  return resolveSessionScope(stamp, mock.interactive, mock.interactive[0], [])
}

beforeEach(() => {
  mock.interactive = []
  mock.library = []
  mock.libraryReads = 0
  mock.socketCount = 0
  mock.rebound = undefined
  mock.targetId = undefined
  mock.saveOptions.mockReset()
  mock.loadOptions.mockReset()
  __resetSessionBindingsForTest()
})

describe('createEngineRefresher', () => {
  /**
   * 这一条是整套机制的落点。
   *
   * 会话钉在 A（关着），B 开着。模型调 `set_session_project(B)` 之后，执行流上的
   * 归属已经是 B 了 —— 体检必须照 B 算。照旧快照（A）算的话，A 没连着，
   * `engineAvailable` 永远是 false，模型改完归属还是一个引擎工具都拿不到，
   * 而工具刚告诉它「下一步就能用引擎工具」。
   */
  it('归属被 set_session_project 改过之后，照新归属重新体检', () => {
    mock.interactive = [B]
    mock.socketCount = 1
    const stamp = { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    setSessionBinding('s1', stamp)
    const refresh = createEngineRefresher('s1', scopeOf(stamp))

    // 起手：钉在 A 上，A 没连着 —— 没有引擎工具
    expect(scopeOf(stamp).engineAvailable).toBe(false)

    // 模型换了归属（set_session_project 写的就是这张表），这一轮的目标也切到了 B
    setSessionBinding('s1', { projectName: 'GameB', projectPath: 'D:/Games/GameB' })
    mock.targetId = 'conn-b'

    const facts = refresh()
    expect(facts?.ueConnected).toBe(true)
    expect(facts?.project?.name).toBe('GameB')
    expect(facts?.sessionProject?.name).toBe('GameB')
  })

  // 解除归属（clear）之后是纯对话，跟着当前连接走
  it('归属被解除之后按纯对话算', () => {
    mock.interactive = [B]
    mock.socketCount = 1
    const stamp = { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    const refresh = createEngineRefresher('s1', scopeOf(stamp))

    mock.rebound = null
    mock.targetId = 'conn-b'

    const facts = refresh()
    expect(facts?.ueConnected).toBe(true)
    expect(facts?.sessionProject).toBeUndefined()
  })

  /**
   * 「连着，但不是你这条会话的工程」也得能刷新。
   *
   * 会话钉在关着的 A 上，中途用户打开了 B：`ueConnected` 还是 false、目标还是空，
   * 只有 `outOfScopeProjects` 变了。签名里漏掉它的话，环境块会一直劝一个明明
   * 连着引擎的人去装插件。
   */
  it('只有「旁边那个连着的工程」变了也要刷新', () => {
    mock.socketCount = 0
    const stamp = { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    setSessionBinding('s1', stamp)
    const refresh = createEngineRefresher('s1', scopeOf(stamp))

    mock.interactive = [B]
    mock.socketCount = 1

    const facts = refresh()
    expect(facts?.ueConnected).toBe(false)
    expect(facts?.outOfScopeProjects).toEqual(['GameB'])
  })

  /**
   * 稳态下**一次库都不读**。
   *
   * 这个回调每一轮都跑，而完整解析里带着一次 `SELECT * FROM projects`（连
   * `projectData` 那几个大字段一起拉）。三十步就是三十次全表读，全压在主进程
   * 那条既跑 IPC 又跑 UE WebSocket 的事件循环上。所以先比一个纯内存的粗签名。
   */
  it('状态没变时回 undefined，而且不碰数据库', () => {
    mock.interactive = [A]
    mock.socketCount = 1
    mock.targetId = 'conn-a'
    const stamp = { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    const refresh = createEngineRefresher('s1', scopeOf(stamp))

    const before = mock.libraryReads
    expect(refresh()).toBeUndefined()
    expect(refresh()).toBeUndefined()
    expect(refresh()).toBeUndefined()
    expect(mock.libraryReads).toBe(before)
  })
})

describe('persistSessionProject', () => {
  /**
   * 归属写进 `sessionProject`，**不碰** `project`。
   *
   * 那两个字段是两件事：`project` 是这一轮打到了哪个工程（execute 开局写的），
   * `sessionProject` 是这条会话属于谁。挤在一起的话，只是恰好在某个工程上跑过、
   * 从没绑过的会话，续跑时会看起来像被钉住了。
   */
  it('归属落在 sessionProject 上，不动这一轮打到的工程', async () => {
    const live = {
      mode: 'agent',
      project: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    } as SessionExecutionOptions

    await persistSessionProject('s1', { projectName: 'GameB', projectPath: 'D:/Games/GameB' }, live)

    expect(live.sessionProject).toEqual({
      projectName: 'GameB',
      projectPath: 'D:/Games/GameB'
    })
    expect(live.project).toEqual({ projectName: 'GameA', projectPath: 'D:/Games/GameA' })
    expect(mock.saveOptions).toHaveBeenCalledWith('s1', live)
  })

  /**
   * 存的是调用方手上那一份，**不再读一遍盘**。
   *
   * 以前是 load-modify-save，`await` 那一下留出一个窗口：`/goal` 的状态机在窗口里
   * 把轮次和改动台账写进了同一个文件，而这边拿着窗口之前读到的快照覆盖回去 ——
   * 复核轮次回退、台账清空，续跑重跑一遍已经做完的复核。
   */
  it('不读盘，直接存调用方那一份 —— goal 的轮次不会被回滚', async () => {
    const live = {
      mode: 'agent',
      goal: { objective: '做完', rounds: 3, lastFailReason: '', mutations: ['x'], settled: false }
    } as SessionExecutionOptions

    await persistSessionProject('s1', { projectName: 'GameB', projectPath: 'D:/B' }, live)

    expect(mock.loadOptions).not.toHaveBeenCalled()
    expect(mock.saveOptions).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        goal: expect.objectContaining({ rounds: 3, mutations: ['x'] })
      })
    )
  })

  /**
   * 解除要落成一个**显式的 `null`**。
   *
   * 删掉字段的话，续跑那边的 `??` 会顺着掉到渲染层传下来的旧戳上，
   * 把刚解除的归属原样复活 —— 而工具当时已经回报过「已解除」。
   */
  it('解除归属落成显式 null，不是删掉字段', async () => {
    const live = {
      mode: 'agent',
      sessionProject: { projectName: 'GameA' }
    } as SessionExecutionOptions

    await persistSessionProject('s1', null, live)

    expect(live.sessionProject).toBeNull()
  })

  // 落盘失败不该让工具调用报错：归属在执行流和渲染层上都已经改过了
  it('落盘失败只吞掉，不抛给工具', async () => {
    mock.saveOptions.mockRejectedValue(new Error('disk full'))
    const live = { mode: 'agent' } as SessionExecutionOptions

    await expect(
      persistSessionProject('s1', { projectName: 'GameB', projectPath: 'D:/B' }, live)
    ).resolves.toBeUndefined()
    expect(live.sessionProject).toEqual({ projectName: 'GameB', projectPath: 'D:/B' })
  })
})

describe('sessionProjectCandidates', () => {
  it('库里的和此刻连着的合起来，连着的标上 connected', () => {
    mock.library = [
      { projectName: 'GameA', projectPath: 'D:/Games/GameA', EngineAssociation: '5.5' }
    ]
    mock.interactive = [B]

    const list = sessionProjectCandidates()
    expect(list).toEqual([
      expect.objectContaining({ projectName: 'GameA', connected: false }),
      // 用户手动打开、还没登记进库的那个也得在 —— 少了它，模型点名一个明明
      // 开着的工程会被回「盒子里没有这个工程」
      expect.objectContaining({ projectName: 'GameB', connected: true })
    ])
  })

  it('同一个工程既在库里又连着时不出现两次', () => {
    mock.library = [
      { projectName: 'GameB', projectPath: 'D:/Games/GameB', EngineAssociation: '5.5' }
    ]
    mock.interactive = [B]

    const list = sessionProjectCandidates()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ projectName: 'GameB', connected: true })
  })
})

describe('currentProjectForFlow', () => {
  // 一轮开始时还没进执行流，退回「最近连上的那个」
  it('没绑目标时跟着最近连上的工程', () => {
    mock.interactive = [A, B]
    expect(currentProjectForFlow()?.connectionId).toBe('conn-b')
  })

  // open_project 切过去之后，命令的实际去处才是「当前工程」
  it('执行流上绑了目标时以目标为准', () => {
    mock.interactive = [A, B]
    mock.targetId = 'conn-a'
    expect(currentProjectForFlow()?.connectionId).toBe('conn-a')
  })
})

/**
 * 「从断点继续」这一轮该按哪个工程戳算。
 *
 * 三档的顺序是有代价的：漏掉第一档，模型明确解除过的归属会被渲染层那份旧戳
 * 原样复活 —— 而工具当时已经跟用户说过「已解除」。
 */
describe('savedBindingSeed', () => {
  it('模型明确解除过就当纯对话，不许掉回渲染层那份戳', () => {
    expect(savedBindingSeed({ mode: 'agent', sessionProject: null } as never)).toBeNull()
  })

  it('模型绑过就按它，压过这一轮打到的工程', () => {
    expect(
      savedBindingSeed({
        mode: 'agent',
        project: { projectName: 'RanIn' },
        sessionProject: { projectName: 'Bound' }
      } as never)
    ).toEqual({ projectName: 'Bound' })
  })

  // 存量会话：写盘时还没有 sessionProject 这个字段，行为必须和以前一样
  it('模型没动过时退回执行记录', () => {
    expect(savedBindingSeed({ mode: 'agent', project: { projectName: 'RanIn' } } as never)).toEqual(
      {
        projectName: 'RanIn'
      }
    )
  })

  /*
   * 没有执行记录时给的是 undefined，**不是 null**。
   * 两者在归属表里不是一回事：undefined 是「模型从没动过」，调用方据此退回
   * 渲染层那份戳；null 是「模型明确解除过」，谁都不许再把它填回去。
   */
  it('压根没有执行记录时交还 undefined，让调用方去退回渲染层的戳', () => {
    expect(savedBindingSeed(undefined)).toBeUndefined()
  })
})

/**
 * 作用域变了要交还给这一轮的运行记录 —— 插话那条路靠它决定去问哪个编辑器。
 *
 * 但**没工程可换时不许换**：插话分两次 IPC 读它（先抓闪存、后核对），
 * 中间换成一个没有工程的作用域，核对必然失败，连拒绝信息里都写不出工程名。
 */
describe('createEngineRefresher 的 onScope', () => {
  it('切到一个连着的工程时把新作用域交出去', () => {
    mock.interactive = [A]
    mock.socketCount = 1
    const seen: Array<string | undefined> = []
    const refresh = createEngineRefresher('s1', scopeOf(null), (next) =>
      seen.push(next.connectedProject?.projectName)
    )

    mock.interactive = [A, B]
    mock.targetId = 'conn-b'
    refresh()

    expect(seen).toEqual(['GameB'])
  })

  it('新作用域没有工程时不动它，留着上一份', () => {
    mock.interactive = [A]
    mock.socketCount = 1
    const stamp = { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    const seen: unknown[] = []
    const refresh = createEngineRefresher('s1', scopeOf(stamp), (next) => seen.push(next))

    // 归属改到一个没开着的工程：作用域算得出来，但里面没有 connectedProject
    mock.rebound = { projectName: 'Closed', projectPath: 'D:/Games/Closed' }
    refresh()

    expect(seen).toEqual([])
  })
})
