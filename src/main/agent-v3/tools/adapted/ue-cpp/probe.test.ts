/**
 * @vitest-environment node
 *
 * `cpp_probe` 的输出是给模型做**动手前决策**用的，所以这里钉的不是「字段有没有
 * 透传」，而是「结论有没有说清楚」：
 *
 *   - 纯蓝图工程要明确说出来，否则模型会开始写它根本编不了的代码；
 *   - Live Coding 路要主动说明「编不过时拿不到报错」，否则模型会等到编译失败
 *     才发现自己两眼一抹黑，而那时候用户已经等了一轮；
 *   - 引擎源码路径要出现在正文里，因为它是「别凭记忆写 UE API」这条要求的落点。
 *
 * 这几条都是**文本**断言。看起来脆，但它们守的正是这个工具的全部价值 ——
 * 它返回的十几个布尔位模型并不会挨个推理，它读的是结论那句话。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { createCppProbeTool } from './probe'

type Executable = {
  execute: (id: string, params: unknown) => Promise<{ content?: { text?: string }[] }>
}

const textOf = (r: { content?: { text?: string }[] }): string =>
  (r.content ?? []).map((c) => c.text ?? '').join('\n')

const run = async (response: Record<string, unknown>): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const tool = createCppProbeTool() as unknown as Executable
  return textOf(await tool.execute('c1', {}))
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('cpp_probe', () => {
  it('发的是 cpp.probe，且不带参数', async () => {
    callRequest.mockResolvedValue({ has_code: true, compile_path: 'hotreload' })
    const tool = createCppProbeTool() as unknown as Executable
    await tool.execute('c1', {})

    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(callRequest.mock.calls[0][0]).toBe('cpp.probe')
    expect(callRequest.mock.calls[0][1]).toEqual({})
  })

  it('纯蓝图工程要明说，不能只回一个 compile_path=none', async () => {
    const text = await run({
      has_code: false,
      compile_path: 'none',
      compile_path_reason: '这是纯蓝图工程（没有 C++ 源码），没有可编译的模块。'
    })

    expect(text).toContain('纯蓝图工程')
    expect(text).toContain('无可用编译路径')
  })

  /**
   * 这条是整个工具最该守住的一条。
   *
   * Live Coding 的编译器报错不落盘（真机验过，），
   * 所以模型必须**在动手之前**就知道这条路是「能编但看不见错」。
   * 只回一个 `compile_path: 'livecoding'` 是不够的 —— 那个词本身不含这个信息。
   */
  it('Live Coding 路要把「拿不到报错」这件事说出来', async () => {
    const text = await run({
      has_code: true,
      compile_path: 'livecoding',
      compile_path_reason:
        '这个会话启用了 Live Coding，编译走它。注意：Live Coding 的编译器报错只显示在 Live Coding 控制台窗口里，不写日志文件，所以编不过时拿不到文件名和行号。想要完整诊断，请关掉 Live Coding 后重启编辑器。'
    })

    expect(text).toContain('Live Coding')
    expect(text).toMatch(/拿不到|看不到|不写日志/)
  })

  /**
   * 回归：真机读回撞出来的（2026-09-03，宿主工程 ProbeHost）。
   * `has_code=false` 不等于「纯蓝图工程」—— .uproject 声明了模块但
   * Source 目录不存在时也是 false，而那是个坏工程，下一步完全不同
   * （不是「加第一个类」，是「你的工程缺了 Source 目录」）。
   */
  it('声明了模块但没源码时，不能说成纯蓝图工程', async () => {
    const text = await run({
      has_code: false,
      declared_module_count: 1,
      compile_path: 'none',
      compile_path_reason: '.uproject 声明了 1 个模块，但磁盘上找不到源码文件…'
    })

    expect(text).toContain('源码缺失')
    expect(text).not.toContain('这是**纯蓝图工程**')
  })

  it('热重载路要说明它能给出完整诊断', async () => {
    const text = await run({
      has_code: true,
      compile_path: 'hotreload',
      compile_path_reason:
        '这个会话没有启用 Live Coding，编译走热重载。这条路编不过时能拿到完整的编译器输出（文件名、行号、原文）。'
    })

    expect(text).toContain('热重载')
    expect(text).toContain('完整的编译器输出')
  })

  it('引擎源码路径要进正文，并且带上「别凭记忆写」这句提醒', async () => {
    const text = await run({
      has_code: true,
      compile_path: 'hotreload',
      engine_source_dir: 'D:/UE_5.5/Engine/Source/',
      project_source_dir: 'H:/Dev/MyGame/Source/'
    })

    expect(text).toContain('D:/UE_5.5/Engine/Source/')
    expect(text).toContain('H:/Dev/MyGame/Source/')
    expect(text).toMatch(/凭记忆|grep/)
  })

  /*
   * 2026-09-08 真机验收案例 9 的回归。
   *
   * 用户在偏好设置里取消了 Live Coding 的勾选但没重启，引擎只是把控制台藏起来
   * （"Console will be hidden but remain running in the background"），会话还在。
   * 那个状态下走热重载会把编辑器卡死 20 分钟 —— 实测过，游戏线程一帧都不动。
   *
   * 插件现在在这种情况下回 compile_path=none。这里钉的是**正文必须把话说清楚**：
   * 不能只显示一个「无可用编译路径」让模型自己猜，得让它知道要请用户重启编辑器。
   */
  it('Live Coding 关了但没重启时，要说清楚是重启的问题', async () => {
    const text = await run({
      has_code: true,
      compile_path: 'none',
      compile_path_reason:
        '这个编辑器会话处在一个「关了但没关干净」的状态……请让用户重启编辑器 —— 重启之后热重载就正常了。',
      live_coding: { available: true, started: true, enabled_for_session: false }
    })

    expect(text).toContain('无可用编译路径')
    expect(text).toContain('重启编辑器')
  })

  /**
   * 老插件不认识 cpp.probe 时会回 404，`callUe` 会抛。这里只确认异常没被吞掉 ——
   * 吞掉再返回一个「看起来成功」的结果，模型会以为探测过了然后接着写代码。
   */
  it('RPC 失败时异常往外抛，不伪装成成功', async () => {
    callRequest.mockResolvedValue({ ok: false, error: 'Unknown method: cpp.probe', code: 404 })
    const tool = createCppProbeTool() as unknown as Executable

    await expect(tool.execute('c1', {})).rejects.toThrow(/cpp\.probe/)
  })
})
