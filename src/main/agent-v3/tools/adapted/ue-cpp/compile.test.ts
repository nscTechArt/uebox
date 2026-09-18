/**
 * @vitest-environment node
 *
 * cpp_compile 只有一件事能在 CI 里验：**失败时说的话对不对**。
 * 编译本身、卡不卡编辑器、回不回响应，全要真机。
 *
 * 这里钉的三条都是「说错话」的具体形态：
 *   - Live Coding 失败时硬凑一个诊断出来（拿不到就是拿不到）
 *   - 超时被说成失败（不知道就是不知道）
 *   - 解析不出来时把原文吞掉（那才是唯一的线索）
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

import { createCppCompileTool } from './compile'

type Executable = {
  execute: (
    id: string,
    params: unknown
  ) => Promise<{ content?: { text?: string }[]; isError?: boolean }>
}

const run = async (
  response: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  callRequest.mockResolvedValue(response)
  const tool = createCppCompileTool() as unknown as Executable
  const r = await tool.execute('c1', {})
  return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: r.isError }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('cpp_compile', () => {
  it('同名函数编译冲突提示检查 Unity 合并顺序', async () => {
    const result = await run({
      result: 'Failed',
      path: 'hotreload',
      output: 'a.cpp(12): error C2084: function already has a body'
    })
    expect(result.text).toContain('Unity')
    expect(result.text).toContain('两处定义')
  })
  it('超时时间必须调大 —— 默认 30 秒编不完任何东西', async () => {
    callRequest.mockResolvedValue({ result: 'Success', path: 'hotreload' })
    const tool = createCppCompileTool() as unknown as Executable
    await tool.execute('c1', {})

    expect(callRequest.mock.calls[0][0]).toBe('cpp.compile')
    expect(callRequest.mock.calls[0][3]).toBeGreaterThanOrEqual(15 * 60 * 1000)
  })

  it('成功时不算 isError', async () => {
    const { text, isError } = await run({ result: 'Success', path: 'hotreload', duration_ms: 8420 })

    expect(text).toContain('编译成功')
    expect(text).toContain('8.4 秒')
    expect(isError).toBeFalsy()
  })

  it('热重载失败要给出文件名和行号', async () => {
    const { text, isError } = await run({
      result: 'Failure',
      path: 'hotreload',
      duration_ms: 8420,
      output: `D:\\Proj\\TurretActor.cpp(42): error C2039: "Tick": 不是 "AActor" 的成员`
    })

    expect(text).toContain('TurretActor.cpp:42')
    expect(text).toContain('C2039')
    // 编不过不是「工具坏了」，是模型要读进去然后改代码的正常结果 ——
    // 走 isError 会抛 ToolFailure，把 details 和诊断正文一起丢掉
    expect(isError).toBeFalsy()
  })

  /**
   * 最要紧的一条。Live Coding 的编译器输出不落盘（真机验过，§12.7），
   * 所以这里**必须**承认读不到，并把出路给出来。硬凑一个诊断是最坏的结果：
   * 模型会拿着编造的行号去改一个没问题的地方。
   */
  it('Live Coding 失败时承认读不到报错，并给出关掉它的出路', async () => {
    const { text } = await run({
      result: 'Failure',
      path: 'livecoding',
      duration_ms: 13970,
      output:
        'LogLiveCoding: Error: Live coding failed, please see Live console for more information'
    })

    expect(text).toContain('读不到')
    expect(text).toContain('关掉 Live Coding')
    // 没有任何编造出来的文件位置
    expect(text).not.toMatch(/\.cpp:\d+/)
  })

  it('超时说的是「不知道成没成」，不是「失败了」', async () => {
    const { text } = await run({ result: 'Timeout', path: 'hotreload', duration_ms: 900000 })

    expect(text).toContain('不知道它成功了没有')
    expect(text).not.toContain('编译失败')
  })

  it('解析不出来时保留原文尾巴，不把唯一的线索吞掉', async () => {
    const { text } = await run({
      result: 'Failure',
      path: 'hotreload',
      output: 'UnrealBuildTool 抛了一个我们没见过形状的异常：Foo.Bar.Baz'
    })

    expect(text).toContain('Foo.Bar.Baz')
  })

  it('NoChanges 不当失败，但要提示去确认文件存没存', async () => {
    const { text, isError } = await run({ result: 'NoChanges', path: 'livecoding' })

    expect(text).toContain('没检测到任何代码改动')
    expect(text).toContain('已保存')
    expect(isError).toBeFalsy()
  })

  /*
   * 2026-09-08 真机验收案例 2 的回归。
   *
   * 引擎在 13 毫秒内同步拒绝了热重载（游戏模块里没有 UObject，没有可重绑的包），
   * 而我们没看返回值，去等一个永远不会广播的完成事件 —— 工具转圈到 20 分钟超时。
   * 插件那边已经改成回 NotStarted + reason；这里钉的是**话不能说错**：
   * 「没发起」和「编译失败」对模型是两件事，后者会让它去改代码找不存在的语法错误。
   */
  it('NotStarted 要说清一行都没编，并带上原因', async () => {
    const { text, isError } = await run({
      result: 'NotStarted',
      path: 'hotreload',
      reason: '这个工程当前加载的游戏模块里，没有任何一个声明过 UObject 类。'
    })

    expect(text).toContain('没有发起')
    expect(text).toContain('没有任何一个声明过 UObject 类')
    expect(text).toContain('改代码解决不了')
    // 「编译失败」会把它引向找语法错误
    expect(text).not.toContain('编译失败')
    expect(isError).toBeFalsy()
  })

  it('NotStarted 但插件没给原因时，不许自己编一个', async () => {
    const { text } = await run({ result: 'NotStarted', path: 'hotreload' })

    expect(text).toContain('没有发起')
    expect(text).toContain('插件没有给出原因')
  })

  /*
   * 2026-09-08 真机验收案例 7 的回归。
   *
   * 那次 Live Coding 真的编译失败了，我们回的却是 Unknown（竞态，插件侧已修）。
   * 这里钉的是**万一还是 Unknown，话不能说错**：Unknown 是「没确认上」，
   * 不是「失败」。说成失败会让模型去改一份可能根本没问题的代码。
   */
  it('Unknown 要说成「没确认上」，不许说成编译失败', async () => {
    const { text, isError } = await run({ result: 'Unknown', path: 'livecoding' })

    expect(text).toContain('没能确认')
    expect(text).toContain('不要假设它失败了')
    expect(text).not.toContain('✗ 编译失败')
    expect(isError).toBeFalsy()
  })

  it('Live Coding 路上 Build.cs 比产物新时要警告，哪怕这次报了成功', async () => {
    const { text } = await run({
      result: 'Success',
      path: 'livecoding',
      needs_full_rebuild: true
    })

    expect(text).toContain('编译成功')
    expect(text).toContain('补不上新的模块依赖')
  })

  /*
   * 2026-09-08 真机验收案例 4 的回归。
   *
   * 原来这条提示不分路，一律说「热重载和 Live Coding 都补不上，需要关掉编辑器完整重编」。
   * 实测把前半句推翻了：热重载路上加 Slate/SlateCore 依赖并调用新模块的 API，
   * 22 秒编过且生效。那句话的代价不是「保守一点」——模型会据此让用户去关编辑器，
   * 而那件事在这个场景里根本不必要。
   */
  it('热重载路上不许因为 Build.cs 变新就让用户关编辑器', async () => {
    const { text } = await run({
      result: 'Success',
      path: 'hotreload',
      needs_full_rebuild: true
    })

    expect(text).toContain('热重载是能处理的')
    expect(text).toContain('不要因为这条提示就让用户关编辑器')
    // 「都补不上」是被实测推翻的那句
    expect(text).not.toContain('都补不上')
  })
})
