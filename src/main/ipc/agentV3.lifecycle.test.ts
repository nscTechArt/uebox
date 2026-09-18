/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionContext } from '../agent-v3/core/createAgent'

type Handler = (event: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  prepare: vi.fn(),
  create: vi.fn(),
  append: vi.fn(),
  load: vi.fn(),
  saveOptions: vi.fn(),
  loadOptions: vi.fn(),
  deleteTranscript: vi.fn(),
  deleteBrowser: vi.fn(),
  deleteCheckpoint: vi.fn(),
  compact: vi.fn(),
  truncate: vi.fn(),
  fork: vi.fn(),
  audit: vi.fn(),
  attachments: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => mock.handlers.set(name, handler) },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../services/agentBrowser', () => ({ deleteSessionBrowser: mock.deleteBrowser }))
vi.mock('../agent-v3/core/promptAttachments', () => ({
  savePromptAttachments: mock.attachments,
  formatAttachmentBlock: () => ''
}))
vi.mock('../agent-v3/smoke', () => ({}))
/*
 * 摊原模块，再只覆盖「要变成没有上下文」的那几个。
 *
 * `vi.mock` 是整模块替换，手抄清单漏一个的表现不是报错：`resolveTargetProject`
 * 整段套着 try/catch，缺失导出抛出来会被它吞掉，返回「不指定」那份默认值 ——
 * 于是这个文件里每一次 execute/continue 都在跑兜底分支，一条工程作用域都没验到，
 * 而套件照样全绿。手抄的另一半代价是纯函数被抄成**另一个行为**：
 * `normalizeProjectPath` 的 `.uproject` 削减曾经就没抄进来，测的于是是替身。
 */
vi.mock('../agent-v3/core/projectTargetContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithTargetConnectionId: (_target: unknown, run: () => unknown) => run(),
  getTargetConnectionId: (): undefined => undefined
}))
// 同上：列全。`setLockChangeListener` 是在模块注册时直接调用的，
// 漏掉它连 try/catch 都兜不住 —— 整个套件在 import 阶段就炸
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
    getInteractiveProjects: () => [],
    getCurrentProject: () => undefined,
    getNonInteractiveProjects: () => []
  }
}))
vi.mock('../agent-v3/toolDiagnostics', () => ({}))
vi.mock('../agent-v3/tools/builtin/localShell', () => ({ isShellAvailable: async () => true }))
vi.mock('../agent-v3/capabilities/mcp', () => ({ ensureConnected: mock.prepare }))
vi.mock('../agent-v3/capabilities/mcp/hostStore', () => ({}))
vi.mock('../agent-v3/tools/registry', () => ({}))
vi.mock('../agent-v3/core/assetSnapshot', () => ({}))
vi.mock('../agent-v3/core/openAsset', () => ({}))
vi.mock('../agent-v3/core/reviewChanges', () => ({}))
vi.mock('../agent-v3/capabilities/plugins/registry', () => ({}))
vi.mock('../agent-v3/core/createAgent', () => ({
  createUnrealAgent: mock.create,
  runSubAgent: mock.audit
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
  compactMessages: mock.compact,
  measureCompaction: () => ({ tokensBefore: 100, tokensAfter: 10, saved: 90 })
}))
vi.mock('../agent-v3/core/compactionCheckpoint', () => ({
  deleteCheckpoint: mock.deleteCheckpoint
}))
vi.mock('../agent-v3/core/transcriptStore', () => ({
  TranscriptStore: class {
    markPersisted = vi.fn()
    append = mock.append
    discard = async (): Promise<void> => {}
  },
  loadTranscript: mock.load,
  truncateTranscript: mock.truncate,
  forkTranscript: mock.fork,
  deleteTranscript: mock.deleteTranscript
}))
vi.mock('../agent-v3/core/sessionExecutionOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-v3/core/sessionExecutionOptions')>()),
  saveExecutionOptions: mock.saveOptions,
  loadExecutionOptions: mock.loadOptions,
  deleteExecutionOptions: async () => {},
  // 原函数内部直接引用模块里的 load/save（不走上面的替身），会一路走到
  // `app.getPath` —— 这里的 electron 替身没有 app
  copyExecutionOptions: async () => {}
}))
vi.mock('../agent-v3/host/runObserver', () => ({ notifyAgentRun: () => {} }))
vi.mock('./realtimeVoice', () => ({ isVoiceTaskSession: () => false }))
vi.mock('../services', () => ({
  serviceManager: { getWebSocketService: () => ({ getConnectionCount: () => 0 }) }
}))
vi.mock('../agent-v3/capabilities/skills', () => ({}))

import {
  __resetSessionBindingsForTest,
  getSessionBinding,
  setSessionBinding
} from '../agent-v3/core/sessionBinding'
import { registerAgentV3IPC } from './agentV3'

const event = { sender: { id: 1, isDestroyed: () => false, send: vi.fn() } }
const manager = { getTools: () => [], getStatuses: () => [] }
const messages: AgentMessage[] = [{ role: 'user', content: 'review only', timestamp: 0 }]
const agent = {
  state: { messages: [] as AgentMessage[], errorMessage: undefined as string | undefined },
  subscribe: vi.fn(),
  prompt: vi.fn(),
  continue: vi.fn(),
  abort: vi.fn(),
  followUp: vi.fn()
}
const created = {
  agent,
  tools: [],
  // 改动台账按**全量**工具名判「这一步算不算改了东西」，所以 createUnrealAgent
  // 现在同时给这一份；替身漏掉它，`/goal` 那几条会话装配当场炸
  allTools: [],
  selection: { providerId: 'faux', modelId: 'test', role: 'agent', model: { contextWindow: 10000 } }
}

function invoke(channel: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return mock.handlers.get(`agent-v3:${channel}`)!(event, args)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 归属表是模块级的，不清会在用例之间串台
  __resetSessionBindingsForTest()
  mock.prepare.mockReset().mockResolvedValue(manager)
  mock.create.mockReset().mockResolvedValue(created)
  mock.load.mockReset().mockResolvedValue(messages)
  mock.append.mockReset().mockResolvedValue(undefined)
  mock.saveOptions.mockReset().mockResolvedValue(undefined)
  mock.loadOptions.mockReset().mockResolvedValue(undefined)
  mock.attachments.mockReset().mockResolvedValue([])
  mock.compact.mockReset()
  mock.truncate.mockReset().mockResolvedValue({ ok: true, messageCount: 1, dropped: 1 })
  mock.fork.mockReset().mockResolvedValue({ ok: true, sessionId: 'branch', messageCount: 2 })
  mock.audit.mockReset().mockResolvedValue({ text: 'VERDICT: PASS — checked' })
  mock.deleteTranscript.mockReset().mockResolvedValue(undefined)
  mock.deleteBrowser.mockReset().mockResolvedValue(undefined)
  agent.state.messages = []
  agent.state.errorMessage = undefined
  agent.prompt.mockReset().mockResolvedValue(undefined)
  agent.continue.mockReset().mockResolvedValue(undefined)
  registerAgentV3IPC()
})

describe('Agent V3 真实 IPC 生命周期', () => {
  it('压缩期间拒绝执行、继续、截断和分支，完成后才允许新任务', async () => {
    mock.load.mockResolvedValue([...messages, ...messages])
    const pending = deferred<{ ok: boolean; messages: AgentMessage[] }>()
    const entered = deferred<void>()
    mock.compact.mockImplementationOnce(() => {
      entered.resolve()
      return pending.promise
    })
    const compacting = invoke('compact', { sessionId: 'compact-lock' })
    await entered.promise
    for (const channel of ['execute', 'continue', 'truncate-session', 'fork-session', 'compact']) {
      expect(
        await invoke(channel, { sessionId: 'compact-lock', prompt: 'new work', keepUserTurns: 1 })
      ).toMatchObject({ success: false })
    }
    expect(agent.prompt).not.toHaveBeenCalled()
    expect(mock.truncate).not.toHaveBeenCalled()
    pending.resolve({ ok: true, messages })
    expect(await compacting).toMatchObject({ success: true })
    expect(
      await invoke('execute', { sessionId: 'compact-lock', prompt: 'new work' })
    ).toMatchObject({ success: true })
  })

  /**
   * 「聊到第六轮发现第三轮就走错了」正是分支最该用的时刻。挡住它的一直是
   * 「盘上落后于内存」（turn_end 才落盘），而那件事只影响还没说完的这一轮 ——
   * 跑着的时候读内存那份就绕开了，见 `liveForkSource`。
   */
  describe('输出中的会话分支', () => {
    const turns = (count: number): AgentMessage[] =>
      Array.from({ length: count }, (_, i) => [
        { role: 'user', content: `问${i + 1}`, timestamp: 0 },
        { role: 'assistant', content: [{ type: 'text', text: `答${i + 1}` }], timestamp: 0 }
      ]).flat() as AgentMessage[]

    /** 起一轮永远不结束的输出，回来时 `run.agent` 已经挂上了 */
    async function startRun(sessionId: string): Promise<void> {
      const reached = deferred<void>()
      agent.prompt.mockImplementationOnce(() => {
        reached.resolve()
        return new Promise(() => {})
      })
      void invoke('execute', { sessionId, prompt: '这一轮还在跑' })
      await reached.promise
      agent.state.messages = turns(3)
    }

    it('从已经收尾的更早一轮分支，切的是内存那份，源会话继续输出', async () => {
      await startRun('live-fork')

      expect(
        await invoke('fork-session', { sessionId: 'live-fork', keepUserTurns: 1 })
      ).toMatchObject({ success: true, sessionId: 'branch' })
      expect(mock.fork).toHaveBeenCalledWith('live-fork', expect.any(String), {
        keepUserTurns: 1,
        sourceMessages: turns(3)
      })
      // 分支没占过锁，也就不该放掉别人的 —— 那一轮仍然登记在跑
      expect(await invoke('execute', { sessionId: 'live-fork', prompt: '再来' })).toMatchObject({
        success: false
      })
    })

    it('整份复制仍然拒绝 —— 要的正是还没说完的这一轮', async () => {
      await startRun('live-whole')

      expect(await invoke('fork-session', { sessionId: 'live-whole' })).toMatchObject({
        success: false,
        reason: 'busy'
      })
      expect(mock.fork).not.toHaveBeenCalled()
    })

    it('切点落在正在输出的这一轮里时拒绝 —— 界面只复制到问题，内核会连半截答案一起带走', async () => {
      await startRun('live-tail')

      expect(
        await invoke('fork-session', { sessionId: 'live-tail', keepUserTurns: 3 })
      ).toMatchObject({ success: false, reason: 'busy' })
      expect(mock.fork).not.toHaveBeenCalled()
    })
  })

  it('压缩期间删除会取消摘要，不允许写回或抢先启动新任务', async () => {
    mock.load.mockResolvedValue([...messages, ...messages])
    const pending = deferred<{ ok: boolean; messages: AgentMessage[] }>()
    const entered = deferred<void>()
    mock.compact.mockImplementationOnce(() => {
      entered.resolve()
      return pending.promise
    })
    const compacting = invoke('compact', { sessionId: 'compact-delete' })
    await entered.promise
    const deleting = invoke('delete-session', { sessionId: 'compact-delete' })
    expect(await invoke('execute', { sessionId: 'compact-delete', prompt: 'new' })).toMatchObject({
      success: false
    })
    pending.resolve({ ok: true, messages })
    expect(await compacting).toMatchObject({ success: false, reason: 'cancelled' })
    expect(await deleting).toMatchObject({ success: true })
    expect(mock.append).not.toHaveBeenCalled()
  })

  it('截断和删除文件的整个异步过程都占用会话', async () => {
    const pending = deferred<{ ok: boolean; messageCount: number; dropped: number }>()
    mock.truncate.mockReturnValueOnce(pending.promise)
    const truncating = invoke('truncate-session', { sessionId: 'truncate-lock', keepUserTurns: 1 })
    expect(await invoke('compact', { sessionId: 'truncate-lock' })).toMatchObject({
      reason: 'busy'
    })
    pending.resolve({ ok: true, messageCount: 1, dropped: 1 })
    await truncating
    const removal = deferred<void>()
    mock.deleteTranscript.mockReturnValueOnce(removal.promise)
    const deleting = invoke('delete-session', { sessionId: 'truncate-lock' })
    expect(await invoke('execute', { sessionId: 'truncate-lock', prompt: 'new' })).toMatchObject({
      success: false
    })
    removal.resolve()
    expect(await deleting).toMatchObject({ success: true })
  })

  it('模型准备期间的只读切换不会被初始配置覆盖，已创建的上下文继续实时读取', async () => {
    const preparation = deferred<typeof manager>()
    mock.prepare.mockReturnValueOnce(preparation.promise)
    const running = invoke('execute', { sessionId: 'live-readonly', prompt: 'work', mode: 'agent' })
    await invoke('set-approval-mode', {
      sessionId: 'live-readonly',
      approvalMode: 'ask',
      mode: 'ask'
    })
    preparation.resolve(manager)
    await running
    const context = mock.create.mock.calls[0][0] as SessionContext
    expect(context.isReadOnly?.()).toBe(true)
    await invoke('set-approval-mode', {
      sessionId: 'live-readonly',
      approvalMode: 'ask',
      mode: 'agent'
    })
    expect(context.isReadOnly?.()).toBe(false)
  })

  it('失败后继续仍装配目标复核，并保存恢复后的轮次', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'agent',
      goal: { objective: '完成目标', rounds: 3, lastFailReason: '', mutations: [], settled: false }
    })
    agent.continue.mockImplementationOnce(async () => {
      const event: AgentEvent = {
        type: 'turn_end',
        message: { role: 'assistant', content: [], stopReason: 'stop' },
        toolResults: []
      } as unknown as AgentEvent
      for (const [listener] of agent.subscribe.mock.calls) await listener(event)
    })
    expect(await invoke('continue', { sessionId: 'goal-resume', mode: 'agent' })).toMatchObject({
      success: true
    })
    expect(agent.subscribe).toHaveBeenCalledTimes(2)
    expect(mock.audit).toHaveBeenCalledTimes(1)
    expect(mock.saveOptions).toHaveBeenLastCalledWith(
      'goal-resume',
      expect.objectContaining({
        goal: expect.objectContaining({ objective: '完成目标', rounds: 4, settled: true })
      })
    )
  })

  it('只有复核中断时继续先复核，不重复请求 worker', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'agent',
      goal: { objective: '完成目标', rounds: 1, lastFailReason: '', mutations: [], settled: false }
    })
    mock.load.mockResolvedValue([
      ...messages,
      { role: 'assistant', content: '已完成', stopReason: 'stop' }
    ])
    expect(await invoke('continue', { sessionId: 'goal-audit-only', mode: 'agent' })).toMatchObject(
      { success: true }
    )
    expect(mock.audit).toHaveBeenCalledTimes(1)
    expect(agent.continue).not.toHaveBeenCalled()
    expect(mock.saveOptions).toHaveBeenLastCalledWith(
      'goal-audit-only',
      expect.objectContaining({ goal: expect.objectContaining({ rounds: 2, settled: true }) })
    )
  })

  it('继续补复核未通过时，将原目标反馈给 worker 再继续', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'agent',
      goal: {
        objective: '完成原目标',
        rounds: 2,
        lastFailReason: '',
        mutations: [],
        settled: false
      }
    })
    mock.load.mockResolvedValue([
      ...messages,
      { role: 'assistant', content: '已完成', stopReason: 'stop' }
    ])
    mock.audit.mockResolvedValue({ text: 'VERDICT: FAIL — 缺少验收' })
    expect(
      await invoke('continue', { sessionId: 'goal-audit-retry', mode: 'agent' })
    ).toMatchObject({ success: true })
    expect(agent.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('完成原目标') })
    )
    expect(agent.continue).toHaveBeenCalledTimes(1)
    expect(mock.saveOptions).toHaveBeenLastCalledWith(
      'goal-audit-retry',
      expect.objectContaining({
        goal: expect.objectContaining({ rounds: 3, lastFailReason: '缺少验收' })
      })
    )
  })
  it.each(['execute', 'continue'])('%s 准备期间停止，不能开始模型请求', async (channel) => {
    const preparation = deferred<typeof manager>()
    const entered = deferred<void>()
    mock.prepare.mockImplementationOnce(() => {
      entered.resolve()
      return preparation.promise
    })
    const running = invoke(channel, { sessionId: channel, prompt: 'work' })
    await entered.promise
    const stopping = invoke('stop', { sessionId: channel })
    preparation.resolve(manager)
    expect(await running).toMatchObject({ success: true, stopped: true })
    expect(await stopping).toMatchObject({ drained: true })
    expect(agent.prompt).not.toHaveBeenCalled()
    expect(agent.continue).not.toHaveBeenCalled()
  })

  it('同一会话准备期间重复启动只允许一个任务', async () => {
    const preparation = deferred<typeof manager>()
    mock.prepare.mockReturnValueOnce(preparation.promise)
    const running = invoke('execute', { sessionId: 'duplicate', prompt: 'work' })
    expect(await invoke('execute', { sessionId: 'duplicate', prompt: 'again' })).toMatchObject({
      success: false
    })
    preparation.resolve(manager)
    expect(await running).toMatchObject({ success: true })
    expect(agent.prompt).toHaveBeenCalledTimes(1)
  })

  it('附件准备期间停止也不能进入 prompt', async () => {
    const attachment = deferred<unknown[]>()
    const entered = deferred<void>()
    mock.attachments.mockImplementationOnce(() => {
      entered.resolve()
      return attachment.promise
    })
    const running = invoke('execute', { sessionId: 'attachment', prompt: 'work' })
    await entered.promise
    const stopping = invoke('stop', { sessionId: 'attachment' })
    attachment.resolve([])
    expect(await running).toMatchObject({ stopped: true })
    expect(await stopping).toMatchObject({ drained: true })
    expect(agent.prompt).not.toHaveBeenCalled()
  })

  it('初始化期间删除先取消并等收尾，再删除历史', async () => {
    const preparation = deferred<typeof manager>()
    mock.prepare.mockReturnValueOnce(preparation.promise)
    const running = invoke('execute', { sessionId: 'delete', prompt: 'work' })
    const deleting = invoke('delete-session', { sessionId: 'delete' })
    expect(mock.deleteTranscript).not.toHaveBeenCalled()
    preparation.resolve(manager)
    await running
    expect(await deleting).toMatchObject({ success: true, wasRunning: true })
    expect(agent.prompt).not.toHaveBeenCalled()
    expect(mock.deleteTranscript).toHaveBeenCalledWith('delete')
    expect(mock.deleteBrowser).toHaveBeenCalledWith('delete')
  })

  /**
   * 删会话要把归属记录一起删掉。
   *
   * 不是纯粹的「免得表一直长」：记录留着的话，`adoptSessionBinding` 会认为这条
   * 会话**已经定过归属**，于是永远不再听渲染层的戳 —— 而 `null`（明确解除）
   * 正是这样一条记录。删了又复用同一个 id 的会话会一直拿不到归属。
   */
  it('删会话连归属记录一起删，不留一条「定过归属」的空壳', async () => {
    setSessionBinding('binding-delete', { projectName: 'GameA', projectPath: 'D:/Games/GameA' })
    expect(getSessionBinding('binding-delete')).toMatchObject({ projectName: 'GameA' })

    expect(await invoke('delete-session', { sessionId: 'binding-delete' })).toMatchObject({
      success: true
    })

    expect(getSessionBinding('binding-delete')).toBeUndefined()
  })

  it('模型初始化失败释放占位，可以再次执行', async () => {
    mock.create.mockRejectedValueOnce(new Error('model unavailable'))
    expect(await invoke('execute', { sessionId: 'retry', prompt: 'work' })).toMatchObject({
      success: false
    })
    expect(await invoke('execute', { sessionId: 'retry', prompt: 'work' })).toMatchObject({
      success: true
    })
  })

  it('重启后的继续任务恢复只读和知识库，界面不能放宽原任务权限', async () => {
    mock.loadOptions.mockResolvedValue({
      mode: 'ask',
      notebook: { id: 'book' },
      thinkingLevel: 'high',
      skillLearning: 'off'
    })
    expect(
      await invoke('continue', { sessionId: 'readonly', mode: 'agent', approvalMode: 'ask' })
    ).toMatchObject({ success: true })
    const context = mock.create.mock.calls[0][0] as SessionContext
    expect(context).toMatchObject({
      mode: 'ask',
      notebook: { id: 'book' },
      thinkingLevel: 'high',
      skillLearning: 'off'
    })
  })

  it('普通任务可以在继续时进一步收紧为只读', async () => {
    mock.loadOptions.mockResolvedValue({ mode: 'agent' })
    await invoke('continue', { sessionId: 'tighten', mode: 'ask' })
    expect(mock.create.mock.calls[0][0]).toMatchObject({ mode: 'ask' })
  })

  it('压缩写盘失败必须报告失败并保留旧检查点', async () => {
    mock.load.mockResolvedValue([...messages, ...messages])
    mock.compact.mockResolvedValue({ ok: true, messages })
    mock.append.mockRejectedValueOnce(new Error('disk full'))
    expect(await invoke('compact', { sessionId: 'compact' })).toMatchObject({
      success: false,
      error: 'disk full'
    })
    expect(mock.append).toHaveBeenCalledWith(messages, { strict: true })
    expect(mock.deleteCheckpoint).not.toHaveBeenCalled()
  })
})
