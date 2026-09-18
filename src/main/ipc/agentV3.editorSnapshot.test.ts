/** @vitest-environment node */
/**
 * 闪存在 IPC 这一层的四件事：
 *
 * 1. **主进程从不自己抓** —— 只用渲染层在提交那一刻给的那份。
 * 2. 拼进提示词的顺序固定：信封 → 闪存 → 附件 → 用户原话。
 * 3. 工程对不上时，`execute` 丢块、`steer` **整条拒绝**。
 * 4. 这一轮钉住的工程落进执行记录，续跑照它走，不重新按「最近连上的」猜。
 *
 * 每一条错了都不会报错，只会让模型悄悄看着另一个工程的选区动手。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

type Handler = (event: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>

const mock = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  create: vi.fn(),
  load: vi.fn(),
  append: vi.fn(),
  saveOptions: vi.fn(),
  loadOptions: vi.fn(),
  interactiveProjects: vi.fn(),
  currentProject: vi.fn(),
  callRequestCalls: [] as unknown[][],
  callRequestImpl: (async () => ({})) as (...args: unknown[]) => Promise<unknown>
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => mock.handlers.set(name, handler) },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../agent-v3/core/promptAttachments', () => ({
  savePromptAttachments: async (images?: readonly unknown[]) =>
    (images?.length ?? 0) > 0 ? [{ path: 'C:/tmp/x.png' }] : [],
  formatAttachmentBlock: (saved: readonly unknown[]) =>
    saved.length > 0 ? '<attachments>fake</attachments>' : ''
}))
vi.mock('../agent-v3/smoke', () => ({}))
// 摊原模块再覆盖，别手抄清单 —— 漏一个会被 `resolveTargetProject` 的 try/catch
// 吞掉，整个套件静默退到兜底分支上（见 lifecycle 那份的注释）
vi.mock('../agent-v3/core/projectTargetContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithTargetConnectionId: (_target: unknown, run: () => unknown) => run(),
  // 这些测试不跑在真的执行流上下文里，所以「没有绑定目标」——
  // `resolveTargetProject` 会照原样退回 `getCurrentProject()`。
  // 归属不在这儿覆盖：它有自己的主人（`sessionBinding`），beforeEach 里清表
  getTargetConnectionId: (): undefined => undefined
}))
vi.mock('../agent-v3/core/assetLock', () => ({
  setLockConflictNotifier: () => {},
  setLockChangeListener: () => {},
  setLockReleaseListener: () => {},
  releaseAll: () => {},
  runWithLockOwner: (_id: string, run: () => unknown) => run()
}))
vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: () => ({}) }))
vi.mock('../sqliteDataBase/models/project', () => ({ getAllProjects: () => [] }))
vi.mock('../services/project/projectManager', () => ({
  projectManager: {
    getInteractiveProjects: mock.interactiveProjects,
    getCurrentProject: mock.currentProject,
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
  createUnrealAgent: mock.create,
  runSubAgent: vi.fn()
}))
vi.mock('../agent-v3/host/eventBridge', () => ({ createEventBridge: () => () => {} }))
vi.mock('../agent-v3/host/approvalChannel', () => ({
  createApprovalRequester: () => async () => 'approve'
}))
vi.mock('../agent-v3/host/questionChannel', () => ({
  createQuestionRequester: () => async () => ({})
}))
vi.mock('../agent-v3/core/streamFn', () => ({
  resolveAgentModel: async () => ({
    models: {},
    summaryModel: {},
    selection: { model: { contextWindow: 10000 } }
  })
}))
vi.mock('../agent-v3/core/compaction', () => ({
  compactMessages: vi.fn(),
  measureCompaction: () => ({ tokensBefore: 100, tokensAfter: 10, saved: 90 })
}))
vi.mock('../agent-v3/core/compactionCheckpoint', () => ({ deleteCheckpoint: vi.fn() }))
vi.mock('../agent-v3/core/transcriptStore', () => ({
  TranscriptStore: class {
    markPersisted = vi.fn()
    append = mock.append
    discard = async (): Promise<void> => {}
  },
  loadTranscript: mock.load,
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
/*
 * WebSocket 替身用普通函数而不是 vi.fn：vi.fn 会给每个返回的 promise 挂一个
 * 记 settledResults 的 .then，返回值是 rejected 时那个派生 promise 没人接，
 * vitest 会把明明通过的用例判成失败。
 */
vi.mock('../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({
      getConnectionCount: () => (mock.interactiveProjects().length > 0 ? 1 : 0),
      callRequest: (...args: unknown[]) => {
        mock.callRequestCalls.push(args)
        return mock.callRequestImpl(...args)
      }
    })
  }
}))
vi.mock('../agent-v3/capabilities/skills', () => ({}))

import { __resetSessionBindingsForTest } from '../agent-v3/core/sessionBinding'
import { registerAgentV3IPC } from './agentV3'
import type { EditorSnapshot } from '../agent-v3/core/editorSnapshot'

const event = { sender: { id: 1, isDestroyed: () => false, send: vi.fn() } }
const messages: AgentMessage[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
const agent = {
  state: { messages: [] as AgentMessage[], errorMessage: undefined as string | undefined },
  subscribe: vi.fn(),
  prompt: vi.fn(),
  continue: vi.fn(),
  steer: vi.fn(),
  abort: vi.fn()
}

const PROJECT_A = {
  connectionId: 'conn-a',
  projectName: 'GameA',
  projectPath: 'D:/Games/GameA',
  connectedAt: 1
}
const PROJECT_B = {
  connectionId: 'conn-b',
  projectName: 'GameB',
  projectPath: 'D:/Games/GameB',
  connectedAt: 2
}

/** 一份来自 A 工程、选了一个蓝图节点的快照 */
const snapshotFromA = (): EditorSnapshot => ({
  capturedAt: '2026-09-07T14:21:33.000Z',
  project: { projectName: 'GameA', projectPath: 'D:/Games/GameA', connectionId: 'conn-a' },
  focus: {
    focusedEditor: { type: 'blueprint', name: 'BP_Player', path: '/Game/BP_Player' },
    selectedNodes: [
      { node_id: 'NODE-1', class: 'K2Node_Event', title: 'Event BeginPlay', pos_x: 0, pos_y: 0 }
    ],
    selectedNodeCount: 1
  }
})

function invoke(channel: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return mock.handlers.get(`agent-v3:${channel}`)!(event, args)
}

/** 这一轮真正送进模型的那段文本 */
function promptText(): string {
  return String(agent.prompt.mock.calls.at(-1)?.[0] ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.handlers.clear()
  // 归属表是模块级的，不清会在用例之间串台
  __resetSessionBindingsForTest()
  mock.create.mockResolvedValue({
    agent,
    tools: [],
    allTools: [],
    selection: {
      providerId: 'faux',
      modelId: 'test',
      role: 'agent',
      model: { contextWindow: 1000 }
    }
  })
  mock.load.mockResolvedValue(messages)
  mock.append.mockResolvedValue(undefined)
  mock.saveOptions.mockResolvedValue(undefined)
  mock.loadOptions.mockResolvedValue(undefined)
  mock.interactiveProjects.mockReturnValue([PROJECT_A])
  mock.currentProject.mockReturnValue(PROJECT_A)
  mock.callRequestCalls.length = 0
  mock.callRequestImpl = async () => ({ focusedEditor: { type: 'level', name: 'M', path: '' } })
  agent.state.messages = []
  agent.state.errorMessage = undefined
  agent.prompt.mockResolvedValue(undefined)
  agent.steer.mockReturnValue(undefined)
  registerAgentV3IPC()
})

describe('execute 拼闪存块', () => {
  it('顺序固定：信封 → 闪存 → 附件 → 用户原话', async () => {
    await invoke('execute', {
      sessionId: 's1',
      prompt: '这个啥意思',
      editorSnapshot: snapshotFromA(),
      images: [{ type: 'image', data: 'x', mimeType: 'image/png' }]
    })

    const text = promptText()
    expect(text.indexOf('<runtime-status')).toBeLessThan(text.indexOf('<editor-snapshot'))
    expect(text.indexOf('<editor-snapshot')).toBeLessThan(text.indexOf('<attachments>'))
    expect(text.indexOf('<attachments>')).toBeLessThan(text.indexOf('这个啥意思'))
    expect(text).toContain('- Event BeginPlay (K2Node_Event) #NODE-1')
  })

  /**
   * 主进程**不兜底抓**。
   *
   * 兜底抓看着更周到，实际上会让气泡上显示的和模型收到的对不上 —— 而用户核对
   * 「AI 是不是看错了地方」靠的就是那行标签。
   */
  it('没给快照就不拼块，也不去问引擎', async () => {
    await invoke('execute', { sessionId: 's2', prompt: '你好' })

    expect(promptText()).not.toContain('<editor-snapshot')
    expect(mock.callRequestCalls).toHaveLength(0)
  })

  it('用户点掉了标签（null）同样不拼块', async () => {
    await invoke('execute', { sessionId: 's3', prompt: '你好', editorSnapshot: null })

    expect(promptText()).not.toContain('<editor-snapshot')
  })

  /**
   * 最后一道闸：快照来自 A，但这一轮实际操作的是 B。
   *
   * 拦不住的话，模型会照着一份看起来完全合理的选区，去改另一个工程里的东西 ——
   * 不报错，回读也「成功」，只是改的不是用户指的那个资产。
   */
  it('快照工程和这一轮的目标对不上 → 不拼块', async () => {
    mock.interactiveProjects.mockReturnValue([PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_B)

    await invoke('execute', {
      sessionId: 's4',
      prompt: '把这个改一下',
      editorSnapshot: snapshotFromA()
    })

    expect(promptText()).not.toContain('<editor-snapshot')
    expect(promptText()).toContain('把这个改一下')
  })

  /** 续跑靠它认回同一个工程，不然半途的任务会跟着「最近连上的」换地方 */
  it('这一轮钉住的工程写进执行记录', async () => {
    await invoke('execute', { sessionId: 's5', prompt: '你好' })

    expect(mock.saveOptions).toHaveBeenCalledWith(
      's5',
      expect.objectContaining({
        project: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
      })
    )
  })
})

describe('steer 的闸', () => {
  /**
   * 把一轮跑到「模型正在思考」那一刻并停在那儿 —— 插话只有在这个状态下才有对象。
   *
   * 必须等到 `agent.prompt` 真的被调用：`reserveRun` 是同步的，但 `run.agent`
   * 要等 `createUnrealAgent` 之后才装上，而 steer 判的正是它。
   */
  async function startRun(sessionId: string): Promise<() => void> {
    let release: () => void = () => {}
    agent.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    void invoke('execute', { sessionId, prompt: '先跑起来' })
    for (let i = 0; i < 50 && agent.prompt.mock.calls.length === 0; i += 1) {
      await Promise.resolve()
    }
    return () => release()
  }

  it('工程一致：块拼在插话前面一起注入', async () => {
    const release = await startRun('run-1')

    expect(
      await invoke('steer', {
        sessionId: 'run-1',
        message: '这个也改了',
        editorSnapshot: snapshotFromA()
      })
    ).toMatchObject({ success: true })

    const injected = String(agent.steer.mock.calls.at(-1)?.[0]?.content ?? '')
    expect(injected).toContain('<editor-snapshot')
    expect(injected).toContain('这个也改了')
    release()
  })

  /**
   * 工程对不上时**整条拒绝**，不是丢掉块照发。
   *
   * 丢块照发的话，模型收到的是一句光秃秃的「这个也改了」，它会在正在跑的那个
   * 工程里找一个根本不存在的「这个」；而界面上那条插话还挂着另一个工程的摘要，
   * 用户完全看不出哪里错了。拒绝之后调用方会把它留在队列里，之后按原工程发。
   */
  it('工程对不上 → 拒绝，一个字都不注入', async () => {
    mock.interactiveProjects.mockReturnValue([PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_B)
    const release = await startRun('run-2')

    const result = await invoke('steer', {
      sessionId: 'run-2',
      message: '这个也改了',
      editorSnapshot: snapshotFromA()
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('GameA')
    expect(agent.steer).not.toHaveBeenCalled()
    release()
  })

  it('不带快照时照旧注入原话', async () => {
    const release = await startRun('run-3')

    expect(await invoke('steer', { sessionId: 'run-3', message: '换个思路' })).toMatchObject({
      success: true
    })
    expect(String(agent.steer.mock.calls.at(-1)?.[0]?.content)).toBe('换个思路')
    release()
  })

  /**
   * 插话可以带图。**不换模型** —— 这一轮用哪个模型跑起来那一刻就定了，中途换
   * 等于把整段 prompt cache 作废；当前模型看不了图时它会照实说自己看不到。
   *
   * 图同样要落盘、把路径写进附件块：模型看得见图，但没有句柄能把它交给工具
   * （见 promptAttachments.ts），而「照着这张生成 3D」正是带图插话最常见的说法。
   */
  it('带图：图进内容块，附件块拼在原话前面', async () => {
    const release = await startRun('run-4')

    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    expect(
      await invoke('steer', { sessionId: 'run-4', message: '照着这张改', images: [image] })
    ).toMatchObject({ success: true })

    const content = agent.steer.mock.calls.at(-1)?.[0]?.content as Array<Record<string, unknown>>
    expect(Array.isArray(content)).toBe(true)
    expect(String(content[0].text)).toContain('<attachments>')
    expect(String(content[0].text)).toContain('照着这张改')
    expect(content[1]).toEqual(image)
    release()
  })

  /**
   * 没带图时形状**一个字节都不变** —— 还是一条纯字符串。
   *
   * 内容块数组只在真有图时才用：给每条插话都换一种形状，等于让每一条都去趟
   * 没人验过的新代码路径，而插话本身是最不该出岔子的那条路。
   */
  it('没带图时还是一条纯字符串，不换形状', async () => {
    const release = await startRun('run-5')

    await invoke('steer', { sessionId: 'run-5', message: '就这样', images: [] })
    expect(typeof agent.steer.mock.calls.at(-1)?.[0]?.content).toBe('string')
    release()
  })
})

describe('抓取 IPC', () => {
  it('外层永远 success:true，抓取成败在 data.ok 里', async () => {
    mock.interactiveProjects.mockReturnValue([])
    mock.currentProject.mockReturnValue(undefined)

    const result = await invoke('editor-snapshot:capture', {})

    // 抛出去的话渲染层的发送流程会整条断掉 —— 闪存抓不到不该让消息发不出去
    expect(result).toEqual({ success: true, data: { ok: false, reason: 'not-connected' } })
  })

  it('抓到时连接 id 是作用域给的那个', async () => {
    await invoke('editor-snapshot:capture', {})

    expect(mock.callRequestCalls).toEqual([['editor.get_focus_context', {}, 'conn-a', 2000]])
  })

  /**
   * 会话在跑时提交的东西（排队的、插的），要跟着**正在跑的那一轮**的工程抓。
   *
   * 自己按会话戳重算是不够的：没盖过戳的会话跟着「最近连上的」走，等待期间
   * 新连上一个工程，抓到的就是别人的编辑器了。
   */
  it('给了 runningSessionId 就用那一轮钉住的工程，忽略当前连接', async () => {
    let release: () => void = () => {}
    agent.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    void invoke('execute', { sessionId: 'busy', prompt: '先跑起来' })
    await Promise.resolve()
    await Promise.resolve()
    mock.callRequestCalls.length = 0

    // 这一轮跑起来之后 B 才连上，"最近连上的"变成了 B
    mock.interactiveProjects.mockReturnValue([PROJECT_A, PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_B)

    const result = await invoke('editor-snapshot:capture', { runningSessionId: 'busy' })

    expect(mock.callRequestCalls).toEqual([['editor.get_focus_context', {}, 'conn-a', 2000]])
    const data = result.data as { ok: boolean; snapshot?: EditorSnapshot }
    expect(data.snapshot?.project.projectName).toBe('GameA')
    release()
  })
})

describe('归属的两个写入方', () => {
  /*
   * 用户在顶栏胶囊 / 侧边栏改归属，走的是 `agent-v3:set-session-project`。
   *
   * 没有这条通道的话：随消息捎带的那份戳只在归属表还空着时用来初始化，
   * 于是会话发过第一条消息之后，用户自己改的归属主进程永远收不到 ——
   * 胶囊上写着 GameB，引擎命令还发往 GameA。
   */
  it('用户在界面上改归属 → 下一条消息就按新工程跑', async () => {
    mock.interactiveProjects.mockReturnValue([PROJECT_A, PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_A)

    // 第一条消息：这条会话还没有归属，跟着当前连着的 GameA 走
    await invoke('execute', { sessionId: 'chip', prompt: 'hi', sessionProject: null })
    expect(
      (mock.create.mock.calls.at(-1)?.[0] as { project?: { name: string } }).project?.name
    ).toBe('GameA')

    // 用户点胶囊，把这条会话归入 GameB
    expect(
      await invoke('set-session-project', {
        sessionId: 'chip',
        project: { projectName: 'GameB', projectPath: 'D:/Games/GameB' }
      })
    ).toMatchObject({ success: true })

    await invoke('execute', { sessionId: 'chip', prompt: '打开关卡', sessionProject: null })

    const context = mock.create.mock.calls.at(-1)?.[0] as { project?: { name: string } }
    expect(context.project?.name).toBe('GameB')
  })

  /*
   * 冷启动第一条消息：执行记录优先于渲染层的戳，和「从断点继续」同一个优先级。
   *
   * 两条路取不同的种子的话，同一条会话在盒子重启后，取决于用户是打字还是点
   * 「从断点继续」，会得到两个不同的归属 —— 模型明确改过的归属落在记录里，
   * 而渲染层那份可能因为窗口没接到事件、或退出前没来得及持久化，还停在改之前。
   */
  it('盒子重启后的第一条消息认执行记录，不认渲染层那份旧戳', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'agent',
      sessionProject: { projectName: 'GameB', projectPath: 'D:/Games/GameB' }
    })
    mock.interactiveProjects.mockReturnValue([PROJECT_A, PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_A)

    await invoke('execute', {
      sessionId: 'cold',
      prompt: '接着做',
      // 渲染层还停在模型改归属之前的 GameA
      sessionProject: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    })

    const context = mock.create.mock.calls.at(-1)?.[0] as { project?: { name: string } }
    expect(context.project?.name).toBe('GameB')
  })

  /*
   * 「上一轮在 GameA 上跑过」不等于「这条对话归属 GameA」。
   *
   * 执行记录里的 `project` 每条会话都有 —— 只要有工程连着，`execute` 就会写上
   * 这一轮实际打到了谁。拿它当归属的种子，会让一条用户从没归类过的普通对话在
   * 重启后被钉死在那个工程上：它没开着就一个引擎工具都没有，而侧边栏和顶栏
   * 胶囊一片空白，用户根本不知道有东西该清。
   *
   * 那条退路只对「从断点继续」成立（半途任务必须回原工程）。这条用例守的就是
   * 两条路的分野：`savedBindingSeed()` 一写进 execute 它就红。
   */
  it('记录里只有「上一轮打到 GameA」→ 新消息不把它当归属', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'agent',
      // 注意：没有 sessionProject —— 从来没有人定过这条会话的归属
      project: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    })
    // GameA 这会儿没开着，只有 GameB 连着
    mock.interactiveProjects.mockReturnValue([PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_B)

    await invoke('execute', { sessionId: 'never-bound', prompt: 'hi', sessionProject: null })

    const context = mock.create.mock.calls.at(-1)?.[0] as {
      project?: { name: string }
      ueConnected?: boolean
    }
    // 纯对话就该跟着当前连着的工程走，而不是被钉在一个没开的工程上失去引擎能力
    expect(context.project?.name).toBe('GameB')
    expect(context.ueConnected).toBe(true)
  })
})

describe('continue 的工程', () => {
  /**
   * 没盖戳的会话在 A 上跑到一半失败，用户顺手把 B 也连上，再点「从断点继续」。
   *
   * 重新解析会话戳的话，算出来的是「当前工程」= 最近连上的 B —— 半途的任务
   * 就换到 B 上接着跑了，一个字都不会说。半途换工程比停下来危险得多。
   */
  it('用执行记录里钉住的工程，不跟着「最近连上的」跑', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'agent',
      project: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    })
    // 末尾留一条 user：planResume 认这个才算「有断点」
    mock.load.mockResolvedValue([
      { role: 'assistant', content: '上一轮说完了', timestamp: 0 },
      { role: 'user', content: '接着做', timestamp: 0 }
    ] as AgentMessage[])
    // 现在两个都连着，当前工程是后连上的 B
    mock.interactiveProjects.mockReturnValue([PROJECT_A, PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_B)

    await invoke('continue', { sessionId: 'resume', sessionProject: null })

    const context = mock.create.mock.calls.at(-1)?.[0] as { project?: { name: string } }
    expect(context.project?.name).toBe('GameA')
  })

  /**
   * 模型明确解除过归属，续跑不许把它复活。
   *
   * 执行记录里的 `sessionProject` 是三态的：**缺省** = 从没定过（这时才回头看
   * `project`），**`null`** = 明确解除过。两者混成一个 `??` 的话，`null` 会顺着
   * 掉到 `project` 上 —— 上一轮实际打到的那个工程被当成归属原样复活，而工具
   * 刚跟用户说过「已解除」。这条用例守的就是那个分支：`??` 一写进去它就红。
   */
  it('执行记录里归属是 null（模型解除过）→ 续跑不拿上一轮的工程复活它', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'agent',
      // 上一轮确实打在 A 上，但归属被明确解除了
      project: { projectName: 'GameA', projectPath: 'D:/Games/GameA' },
      sessionProject: null
    })
    mock.load.mockResolvedValue([
      { role: 'assistant', content: '上一轮说完了', timestamp: 0 },
      { role: 'user', content: '接着做', timestamp: 0 }
    ] as AgentMessage[])
    mock.interactiveProjects.mockReturnValue([PROJECT_A, PROJECT_B])
    mock.currentProject.mockReturnValue(PROJECT_B)

    // 渲染层还带着解除前的旧戳上来 —— 表里已经有记录了，它不该被采信
    await invoke('continue', {
      sessionId: 'resume-cleared',
      sessionProject: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    })

    const context = mock.create.mock.calls.at(-1)?.[0] as { project?: { name: string } }
    // 解除之后就是普通对话：作用域退回「当前工程」，而不是被钉在 A 上
    expect(context.project?.name).not.toBe('GameA')
  })
})
