import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'

import { agentV3API } from './agentV3'
import { aiAPI } from './ai'
import { toPlainEditorSnapshot, type EditorSnapshot } from '@core/shared/editorSnapshot'

/**
 * 过 IPC 的东西必须是**能被结构化克隆的普通数据**。
 *
 * 渲染层这边到处是 Pinia 的响应式代理：会话戳从 store 读出来是代理，排着队的那份
 * 快照存进 store 再取出来也是代理。而结构化克隆搬不动 Proxy —— Electron 直接抛
 * `An object could not be cloned.`。
 *
 * 两处发作都不像是闪存的锅：
 *   - 抓取那一路被 `captureEditorSnapshot` 的兜底吞掉 → 表现成「莫名其妙没有快照」
 *   - 投递那一路整条消息发不出去 → 用户按了发送，屏幕上什么都没有
 *
 * `toSessionProjectPayload` 的注释里记着同一个坑上一次发作（加工程归属透传那次，
 * 每条消息都弹「Agent 执行异常」）。所以这次用**真的克隆**来测，不是比对象长相。
 */

/** Electron 那条通道真正做的事：结构化克隆一遍。搬不动就抛 */
function throughIpc<T>(value: T): T {
  return structuredClone(value)
}

const snapshot = (): EditorSnapshot => ({
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

describe('响应式代理不能直接过 IPC', () => {
  /** 先证明这个坑是真的 —— 不然下面的修法看着像多余的 */
  it('结构化克隆搬不动 Vue 的响应式代理', () => {
    expect(() => throughIpc(reactive(snapshot()))).toThrow()
    expect(() => throughIpc(reactive({ projectName: 'GameA' }))).toThrow()
  })

  it('toPlainEditorSnapshot 拍平之后能过', () => {
    const proxied = reactive(snapshot())

    const plain = toPlainEditorSnapshot(proxied)

    expect(() => throughIpc(plain)).not.toThrow()
    // 拍平不能把内容弄丢 —— 嵌套那层节点也要在
    expect(plain?.focus.selectedNodes?.[0].node_id).toBe('NODE-1')
    expect(plain?.project.projectPath).toBe('D:/Games/GameA')
  })

  /** `ref` 包一层再取 `.value` 是排队那条路的真实形状 */
  it('从 ref 里取出来的那份也拍得平', () => {
    const stored = ref<EditorSnapshot | null>(snapshot())

    expect(() => throughIpc(toPlainEditorSnapshot(stored.value))).not.toThrow()
  })

  it('没有快照时给 null，不是 undefined 也不抛', () => {
    expect(toPlainEditorSnapshot(null)).toBeNull()
    expect(toPlainEditorSnapshot(undefined)).toBeNull()
  })
})

describe('captureEditorSnapshot 过桥前拍平工程戳', () => {
  beforeEach(() => {
    // @ts-expect-error 测试环境里没有 preload 注入的 window.api
    window.api = { agentV3: {} }
  })

  /**
   * 调用方给的多半就是 store 里那份代理（`chatStore.getProject(...)`）。
   * 这一层不拍平的话，异常会被自己的 catch 吞掉 —— 用户永远查不出为什么没快照。
   */
  it('收到响应式代理也能过真实的克隆', async () => {
    const invoke = vi.fn().mockImplementation((args) => {
      throughIpc(args) // 搬不动就在这儿炸，和真实通道一样
      return Promise.resolve({ success: true, data: { ok: false, reason: 'not-connected' } })
    })
    window.api.agentV3.captureEditorSnapshot = invoke

    const result = await agentV3API.captureEditorSnapshot({
      sessionProject: reactive({ projectName: 'GameA', projectPath: 'D:/Games/GameA' })
    })

    // 没有静默变成 error —— 说明那一趟真的过去了
    expect(result).toEqual({ ok: false, reason: 'not-connected' })
    expect(invoke).toHaveBeenCalledWith({
      sessionProject: { projectName: 'GameA', projectPath: 'D:/Games/GameA' }
    })
  })

  it('空工程名归一成 null，不会把会话锁死在一个空名字的工程上', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ success: true, data: { ok: false, reason: 'error' } })
    window.api.agentV3.captureEditorSnapshot = invoke

    await agentV3API.captureEditorSnapshot({ sessionProject: { projectName: '  ' } })

    expect(invoke).toHaveBeenCalledWith({ sessionProject: null })
  })
})

describe('executeAgent 过桥前拍平快照和工程戳', () => {
  beforeEach(() => {
    // @ts-expect-error 测试环境里没有 preload 注入的 window.api
    window.api = { agentV3: {} }
  })

  /**
   * 排队投递那条路：快照在 Pinia 里存过一趟，取出来是代理。
   *
   * 这里炸掉的后果比抓取那条重 —— 抓取失败只是这条消息不带快照，
   * 而这里失败是**整条消息发不出去**：用户按了发送，屏幕上什么都没有。
   */
  it('排队里存过一趟的快照（响应式代理）也能过真实的克隆', async () => {
    const execute = vi.fn().mockImplementation((args) => {
      throughIpc(args)
      return Promise.resolve({ success: true })
    })
    window.api.agentV3.execute = execute

    await aiAPI.executeAgent(
      {
        sessionId: 'agent-1',
        messages: [{ role: 'user', content: '这个啥意思' }],
        editorSnapshot: reactive(snapshot()),
        sessionProject: reactive({ projectName: 'GameA', projectPath: 'D:/Games/GameA' })
      },
      {}
    )

    const args = execute.mock.calls[0][0]
    expect(() => throughIpc(args)).not.toThrow()
    expect(args.editorSnapshot.focus.selectedNodes[0].node_id).toBe('NODE-1')
    expect(args.sessionProject).toEqual({ projectName: 'GameA', projectPath: 'D:/Games/GameA' })
  })

  /** 用户点掉 / 没抓到时是 `null`，这跟「这个入口还没接闪存」（键不存在）要分开 */
  it('null 照样带下去，undefined 就整个键不出现', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true })
    window.api.agentV3.execute = execute

    await aiAPI.executeAgent({ sessionId: 'a', prompt: 'hi', editorSnapshot: null }, {})
    expect(execute.mock.calls[0][0]).toHaveProperty('editorSnapshot', null)

    execute.mockClear()
    await aiAPI.executeAgent({ sessionId: 'a', prompt: 'hi' }, {})
    expect(execute.mock.calls[0][0]).not.toHaveProperty('editorSnapshot')
  })
})
