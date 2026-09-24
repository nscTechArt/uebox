/**
 * @vitest-environment node
 *
 * 建类这件事，模型最容易在两个地方走错：
 *   - 引擎顺手编了 vs 没编 —— 分不清就会漏掉一次 cpp_compile，然后纳闷新类为什么用不了；
 *   - FailedToHotReload —— 那种情况**文件已经写出去了**，当成「失败了重来一次」
 *     就会撞上「文件已存在」，或者更糟，建出第二个名字带后缀的类。
 * 这两条各钉一个用例。
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

import { createCppAddClassTool } from './addClass'

type Executable = {
  execute: (id: string, params: unknown) => Promise<{ content?: { text?: string }[] }>
}

const run = async (
  response: Record<string, unknown>,
  input: Record<string, unknown> = { name: 'TurretActor', parent_class: 'Actor' }
): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const tool = createCppAddClassTool() as unknown as Executable
  const r = await tool.execute('c1', input)
  return (r.content ?? []).map((c) => c.text ?? '').join('\n')
}

const OK = {
  result: 'Succeeded',
  module: 'MyGame',
  header_path: 'H:/Dev/MyGame/Source/MyGame/TurretActor.h',
  cpp_path: 'H:/Dev/MyGame/Source/MyGame/TurretActor.cpp'
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('cpp_add_class', () => {
  it('参数原样传给 cpp.add_class，location 有默认值', async () => {
    await run(OK)

    expect(callRequest.mock.calls[0][0]).toBe('cpp.add_class')
    expect(callRequest.mock.calls[0][1]).toEqual({
      name: 'TurretActor',
      parent_class: 'Actor',
      location: 'default'
    })
  })

  it('成功时把两个文件路径摆出来', async () => {
    const text = await run({ ...OK, reloaded: true })

    expect(text).toContain('TurretActor.h')
    expect(text).toContain('TurretActor.cpp')
    expect(text).toContain('MyGame')
  })

  it('引擎顺手编了就说编了', async () => {
    const text = await run({ ...OK, reloaded: true })

    expect(text).toContain('现在就能用')
  })

  it('没编就明确要求接下来调 cpp_compile', async () => {
    const text = await run({ ...OK, reloaded: false })

    expect(text).toContain('还没有编译')
    expect(text).toContain('cpp_compile')
  })

  /**
   * `FailedToHotReload` 是引擎的原话：**代码加成功了，只是没能热加载**。
   * 当成普通失败去重试，轻则撞「文件已存在」，重则建出第二个类。
   */
  it('FailedToHotReload 要提醒文件可能已经写出去了', async () => {
    const text = await run({
      ...OK,
      result: 'FailedToHotReload',
      fail_reason: "Failed to automatically compile the 'MyGame' module."
    })

    expect(text).toContain('文件可能已经写出去了')
    expect(text).toContain('别重复创建')
    // 部分完成：第一句不说「建类失败」，也不抛成错误
    expect(text.startsWith('⚠️ 部分完成')).toBe(true)
  })

  /**
   * 没建成要标 isError（defineTool 把它转成 ToolFailure 抛出）。以前正文是 ✗
   * 却按成功返回，熔断器看不见，同一组参数可以无限重试。
   */
  it('失败时标 isError，并把引擎给的原因带上，不自己编一个', async () => {
    await expect(
      run({
        result: 'InvalidInput',
        fail_reason: '类名 3Foo 不合法：名字不能以数字开头'
      })
    ).rejects.toThrow('不能以数字开头')
  })

  it('FailedToAddCode 也标 isError', async () => {
    await expect(run({ result: 'FailedToAddCode', fail_reason: 'disk full' })).rejects.toThrow(
      /✗ 建类失败[\s\S]*disk full/
    )
  })
})
