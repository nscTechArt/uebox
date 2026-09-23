import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RealtimeSessionConfig } from '../ai/realtime/types'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  connections: [] as Array<{
    history: RealtimeSessionConfig['history']
    instructions: string
    onEvent: RealtimeSessionConfig['onEvent']
    handle: { close: ReturnType<typeof vi.fn>; announce: ReturnType<typeof vi.fn> }
  }>,
  readSettings: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, args?: unknown) => unknown) =>
      mock.handlers.set(name, fn),
    on: (name: string, fn: (event: unknown, args?: unknown) => unknown) =>
      mock.handlers.set(name, fn)
  }
}))
vi.mock('../agent-v3/tools/adapted/project/splitByRisk', () => ({ createProjectListTool: vi.fn() }))
vi.mock('../ai/credentials', () => ({ resolveApiKey: async () => 'test-placeholder' }))
vi.mock('../ai/store', () => ({ readSettings: mock.readSettings }))
vi.mock('../agent-v3/core/focusContext', () => ({ getFocusContext: vi.fn() }))
vi.mock('../services/project', () => ({ projectManager: { getInteractiveProjects: () => [] } }))
vi.mock('../ai/piCompletion', () => ({
  completeText: async () => '',
  resolveBinding: async () => ({ provider: {}, modelId: '' }),
  userMessage: (text: string) => text
}))
vi.mock('../ai/realtime/doubaoRealtime', () => ({
  DOUBAO_AUDIO: { inputSampleRate: 16000, outputSampleRate: 24000 },
  isDoubaoRealtimeUrl: () => false,
  openDoubaoRealtimeSession: vi.fn()
}))
vi.mock('../ai/realtime/openaiRealtime', () => ({
  OPENAI_AUDIO: { inputSampleRate: 24000, outputSampleRate: 24000 },
  openOpenAiRealtimeSession: (config: RealtimeSessionConfig) => {
    const handle = {
      close: vi.fn(),
      announce: vi.fn(),
      appendAudio: vi.fn(),
      sendText: vi.fn(),
      cancelResponse: vi.fn(),
      sendToolResults: vi.fn()
    }
    mock.connections.push({
      onEvent: config.onEvent,
      history: config.history,
      instructions: config.instructions,
      handle
    })
    return handle
  }
}))
const settings = {
  roles: { realtime: { providerId: 'test', modelId: 'test-model' } },
  providers: [{ id: 'test', baseUrl: 'https://test.invalid/v1', apiKey: '', models: [] }]
}

describe('语音 IPC 生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mock.handlers.clear()
    mock.connections.length = 0
    mock.readSettings.mockReset().mockResolvedValue(settings)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function harness(): Promise<{
    sender: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
    invoke: (name: string, args?: unknown) => unknown
    start: () => Promise<void>
    notifyAgentRun: typeof import('../agent-v3/host/runObserver').notifyAgentRun
  }> {
    const { registerRealtimeVoiceIPC } = await import('./realtimeVoice')
    const { notifyAgentRun } = await import('../agent-v3/host/runObserver')
    registerRealtimeVoiceIPC()
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }
    const invoke = (name: string, args?: unknown): unknown =>
      mock.handlers.get(`realtime-voice:${name}`)!({ sender }, args)
    const start = async (): Promise<void> => {
      const result = (await invoke('start')) as { connectionId: number }
      mock.connections.at(-1)!.onEvent({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(0)
      invoke('playback-ready', result.connectionId)
    }
    return { sender, invoke, start, notifyAgentRun }
  }

  it('中途开启语音保留长回复末尾的下一步问题，且不扩大历史预算', async () => {
    const { invoke } = await harness()
    const opening = '修复已经完成。'
    const ending = '要不要推送到远端？我只在本地提交了，没有 push。'
    await invoke('start', {
      history: [
        { role: 'user', text: '修复问题' },
        { role: 'assistant', text: opening + '验证结果。'.repeat(300) + ending }
      ]
    })
    const history = mock.connections[0].history!
    expect(history[0]).toEqual({ role: 'user', text: '修复问题' })
    expect(history[1].text.startsWith(opening)).toBe(true)
    expect(history[1].text.endsWith(ending)).toBe(true)
    expect(history[1].text).toBe(opening + '验证结果。'.repeat(300) + ending)
    await invoke('stop')
  })

  it('最新轮过长时通知模型缺少历史，不能当成新对话', async () => {
    const { invoke } = await harness()
    await invoke('start', {
      history: [
        { role: 'user', text: '请求' },
        { role: 'assistant', text: '很长的回答'.repeat(2000) }
      ]
    })
    expect(mock.connections[0].history).toEqual([])
    expect(mock.connections[0].instructions).toContain('并非新对话')
    await invoke('stop')
  })

  it('没有等待审批时提示接续普通对话，不声称没有上下文', async () => {
    const { invoke } = await harness()
    expect(invoke('approve-task', {})).toMatchObject({
      found: false,
      text: expect.stringContaining('dispatch_task')
    })
  })

  it('详细反馈关闭自动结束后，空闲不会挂断', async () => {
    const { invoke, start } = await harness()
    invoke('anti-silence', true)
    invoke('auto-hangup', false)
    await start()
    await vi.advanceTimersByTimeAsync(240_000)
    expect(mock.connections[0].handle.announce).not.toHaveBeenCalled()
    expect(mock.connections[0].handle.close).not.toHaveBeenCalled()
    await invoke('stop')
  })

  it('简洁反馈开启自动结束后，空闲告别完成会关闭通话', async () => {
    const { invoke, start } = await harness()
    invoke('anti-silence', false)
    invoke('auto-hangup', true)
    await start()
    await vi.advanceTimersByTimeAsync(210_000)
    expect(mock.connections[0].handle.announce).toHaveBeenCalledTimes(3)
    expect(mock.connections[0].handle.close).toHaveBeenCalledOnce()
  })

  it('简洁反馈可自动结束，告别期间关闭开关取消挂断', async () => {
    const { invoke, start } = await harness()
    invoke('anti-silence', false)
    invoke('auto-hangup', true)
    await start()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(mock.connections[0].handle.announce).toHaveBeenCalledTimes(3)
    invoke('auto-hangup', false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mock.connections[0].handle.close).not.toHaveBeenCalled()
    await invoke('stop')
  })

  it('挂断期间仍跟踪完成结果，再连后能继续派发', async () => {
    const { invoke, start, notifyAgentRun } = await harness()
    await start()
    const task = invoke('dispatch', {
      instruction: 'create material',
      agentSessionId: 'worker'
    }) as { taskId: string }
    await invoke('stop')
    notifyAgentRun({ type: 'done', sessionId: 'worker' })
    notifyAgentRun({ type: 'released', sessionId: 'worker' })
    await start()
    expect(
      (invoke('describe-task', { taskId: task.taskId }) as { text: string }).text
    ).not.toContain('还在跑')
    expect(invoke('dispatch', { instruction: 'next job', agentSessionId: 'worker' })).toMatchObject(
      { action: 'start' }
    )
    await invoke('stop')
  })

  /*
   * 用户说「不用了，再见」，助手道了别，麦克风却一直开着 —— 他以为挂了，
   * 接下来在旁边说的每句话还在往上传。防冷场那条路只认「没人说话」，听不懂道别。
   */
  it('说了再见就能挂，但有活在跑时先拦一次，用户坚持才放行', async () => {
    const { invoke, start } = await harness()
    await start()

    expect(invoke('end-call', {})).toMatchObject({ hangUp: true })

    invoke('dispatch', { instruction: '删掉那些测试分组', agentSessionId: 'worker' })
    const blocked = invoke('end-call', {}) as { hangUp: boolean; text: string }
    expect(blocked.hangUp).toBe(false)
    // 拦下来之后要让模型说得出在跑什么，只说「不行」的话用户不知道该怎么办
    expect(blocked.text).toContain('删掉那些测试分组')
    expect(invoke('end-call', { force: true })).toMatchObject({ hangUp: true })

    // 挂断本身仍然走渲染层 —— 告别得先念完，这里只回答「能不能」
    expect(mock.connections[0].handle.close).not.toHaveBeenCalled()
    await invoke('stop')
  })

  it('旧连接关闭或报错，不转发给新通话也不关闭新通话', async () => {
    const { sender, invoke, start } = await harness()
    await start()
    await invoke('stop')
    await start()
    sender.send.mockClear()
    mock.connections[0].onEvent({ type: 'closed' })
    mock.connections[0].onEvent({ type: 'error', message: 'old failure' })
    expect(sender.send).not.toHaveBeenCalled()
    expect(mock.connections[1].handle.close).not.toHaveBeenCalled()
    mock.connections[1].onEvent({ type: 'assistant-text', text: '新通话' })
    expect(sender.send).toHaveBeenCalledWith('realtime-voice:event', {
      type: 'assistant-text',
      text: '新通话'
    })
    await invoke('stop')
  })

  it('重连后等待播放设备就绪才派队列和播报，旧就绪通知无效', async () => {
    const { sender, invoke, start, notifyAgentRun } = await harness()
    await start()
    invoke('dispatch', { instruction: 'first', agentSessionId: 'worker' })
    invoke('dispatch', {
      instruction: 'second',
      executionInstruction: 'second only A',
      agentSessionId: 'worker'
    })
    await invoke('stop')
    notifyAgentRun({ type: 'done', sessionId: 'worker' })
    notifyAgentRun({ type: 'released', sessionId: 'worker' })
    const result = (await invoke('start')) as { connectionId: number }
    mock.connections[1].onEvent({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(0)
    sender.send.mockClear()
    invoke('playback-ready', result.connectionId - 2)
    expect(sender.send).not.toHaveBeenCalled()
    expect(mock.connections[1].handle.announce).not.toHaveBeenCalled()
    invoke('playback-ready', result.connectionId)
    expect(sender.send).toHaveBeenCalledWith(
      'realtime-voice:run-task',
      expect.objectContaining({
        instruction: 'second',
        executionInstruction: 'second only A',
        attempt: 1
      })
    )
    expect(mock.connections[1].handle.announce).toHaveBeenCalled()
    await invoke('stop')
  })

  it('问答结束通知带上任务号，不广播其他会话或过期问题', async () => {
    const { sender, invoke, start, notifyAgentRun } = await harness()
    await start()
    const task = invoke('dispatch', { instruction: 'work', agentSessionId: 'worker' }) as {
      taskId: string
    }
    notifyAgentRun({
      type: 'question',
      sessionId: 'worker',
      toolCallId: 'question-1',
      questions: []
    })
    sender.send.mockClear()
    notifyAgentRun({ type: 'question-settled', sessionId: 'other', toolCallId: 'question-other' })
    notifyAgentRun({ type: 'question-settled', sessionId: 'worker', toolCallId: 'question-old' })
    expect(sender.send).not.toHaveBeenCalled()
    notifyAgentRun({ type: 'question-settled', sessionId: 'worker', toolCallId: 'question-1' })
    expect(sender.send).toHaveBeenCalledWith('realtime-voice:event', {
      type: 'question-settled',
      taskId: task.taskId
    })
    await invoke('stop')
  })

  it('读取配置时取消连接，迟到的配置不能再开网络连接', async () => {
    const { invoke } = await harness()
    let resolveSettings: (value: typeof settings) => void = () => {}
    mock.readSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve
        })
    )
    const starting = invoke('start')
    await invoke('stop')
    resolveSettings(settings)
    await expect(starting).resolves.toMatchObject({ ok: false })
    expect(mock.connections).toHaveLength(0)
  })

  /** 还没开好时，别的窗口来一句 stop（比如被让掉的 Spotlight 收尾）不能把这一路取消掉 */
  it('开到一半时别的窗口来 stop：不取消', async () => {
    const { invoke } = await harness()
    let resolveSettings: (value: typeof settings) => void = () => {}
    mock.readSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve
        })
    )
    const starting = invoke('start')
    await mock.handlers.get('realtime-voice:stop')!({ sender: { id: 2 } })
    resolveSettings(settings)

    await expect(starting).resolves.toMatchObject({ ok: true })
    expect(mock.connections).toHaveLength(1)
  })

  /**
   * 通话和听写同时在等密钥：谁后开完都不能把先开的那路从 `active` 上盖掉 ——
   * 被盖掉的那路没人再管，一直开着计费。通话优先，听写让路
   */
  it('通话和听写同时在开：只留一路，被让掉的那路关掉', async () => {
    const { invoke } = await harness()
    const spotlight = { id: 2, isDestroyed: () => false, send: vi.fn() }
    let resolveCall: (value: typeof settings) => void = () => {}
    mock.readSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve
        })
    )
    const call = invoke('start')
    const dictation = mock.handlers.get('realtime-voice:start-dictation')!({ sender: spotlight })

    await expect(dictation).resolves.toMatchObject({ ok: true })
    resolveCall(settings)
    await expect(call).resolves.toMatchObject({ ok: true })

    expect(mock.connections).toHaveLength(2)
    // 听写那路（先开的）被通话让掉并关掉了，Spotlight 收到一声 closed
    expect(mock.connections[0].handle.close).toHaveBeenCalled()
    expect(spotlight.send).toHaveBeenCalledWith('realtime-voice:event', { type: 'closed' })
  })

  it('听写等密钥期间通话先接上了：听写回 busy，不盖掉通话', async () => {
    const { invoke } = await harness()
    const spotlight = { id: 2, isDestroyed: () => false, send: vi.fn() }
    let resolveDictation: (value: typeof settings) => void = () => {}
    mock.readSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDictation = resolve
        })
    )
    const dictation = mock.handlers.get('realtime-voice:start-dictation')!({ sender: spotlight })
    await expect(invoke('start')).resolves.toMatchObject({ ok: true })
    resolveDictation(settings)

    await expect(dictation).resolves.toMatchObject({ ok: false, reason: 'busy' })
    expect(mock.connections).toHaveLength(1)
    expect(mock.connections[0].handle.close).not.toHaveBeenCalled()
  })
})
