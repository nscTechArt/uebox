/**
 * @vitest-environment node
 *
 * `cpp_list_modules` 回答的是「这个类该写进哪个模块」。这里钉三件事：
 * 参数按开关传对、模块类型要出现在给模型看的正文里（Runtime 里 include
 * 编辑器模块是最典型的「开发时全绿、打包时全红」）、以及两种「列不出东西」
 * 的情况必须给出**不同**的下一步。
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

import { createCppListModulesTool } from './listModules'

type Executable = {
  execute: (id: string, params: unknown) => Promise<{ content?: { text?: string }[] }>
}

const textOf = (r: { content?: { text?: string }[] }): string =>
  (r.content ?? []).map((c) => c.text ?? '').join('\n')

const run = async (
  response: Record<string, unknown>,
  input: Record<string, unknown> = {}
): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const tool = createCppListModulesTool() as unknown as Executable
  return textOf(await tool.execute('c1', input))
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('cpp_list_modules', () => {
  it('默认不带插件模块，显式打开时才传 true', async () => {
    await run({ has_code: true, modules: [] })
    expect(callRequest.mock.calls[0][0]).toBe('cpp.list_modules')
    expect(callRequest.mock.calls[0][1]).toEqual({ include_plugins: false })

    callRequest.mockReset()
    await run({ has_code: true, modules: [] }, { include_plugins: true })
    expect(callRequest.mock.calls[0][1]).toEqual({ include_plugins: true })
  })

  it('列出模块时要带上类型和源码路径，并提醒 Runtime 的坑', async () => {
    const text = await run({
      has_code: true,
      modules: [
        {
          name: 'MyGame',
          type: 'Runtime',
          source_path: 'H:/Dev/MyGame/Source/MyGame/',
          origin: 'project'
        },
        {
          name: 'MyGameEditor',
          type: 'Editor',
          source_path: 'H:/Dev/MyGame/Source/MyGameEditor/',
          origin: 'project'
        }
      ]
    })

    expect(text).toContain('共 2 个模块')
    expect(text).toContain('MyGame')
    expect(text).toContain('Runtime')
    expect(text).toContain('H:/Dev/MyGame/Source/MyGameEditor/')
    expect(text).toContain('打包')
  })

  it('插件模块要标出来 —— 往插件里写和往工程里写不是一回事', async () => {
    const text = await run(
      {
        has_code: true,
        modules: [
          { name: 'MyPluginRuntime', type: 'Runtime', source_path: 'H:/p/', origin: 'plugin' }
        ]
      },
      { include_plugins: true }
    )

    expect(text).toContain('插件')
  })

  /**
   * 两种「没有模块」要给出不同的下一步，不能都回一句「共 0 个模块」：
   * 纯蓝图工程是**正常状态**，下一步是请用户手动加第一个类；
   * 有代码却列不出模块是**异常状态**，下一步是让用户确认工程能不能编。
   */
  it('纯蓝图工程说清楚要用户手动加第一个类', async () => {
    const text = await run({ has_code: false, modules: [] })

    expect(text).toContain('纯蓝图工程')
    expect(text).toContain('New C++ Class')
  })

  it('有代码却一个模块都没有，要说这不正常', async () => {
    const text = await run({ has_code: true, modules: [] })

    expect(text).toContain('不正常')
    expect(text).not.toContain('共 0 个模块')
  })

  /**
   * 回归：真机读回撞出来的（2026-09-03，宿主工程 ProbeHost）。
   *
   * `has_code=false` 但模块列表里有东西 —— 两个字段数据源不同：
   * `ProjectHasCodeFiles()` 数磁盘上的源文件，`GetCurrentProjectModules()`
   * 读 .uproject 的 Modules 段。工程拷贝时漏了 Source 目录就长这样。
   *
   * 初版把 `has_code === false` 放在最前面短路，于是这种工程被说成
   * 「纯蓝图工程，没有 C++ 模块」——既错，又把已经拿到的模块列表丢了。
   */
  it('has_code=false 但有模块时，照样列出来并指出源码缺失', async () => {
    const text = await run({
      has_code: false,
      count: 1,
      modules: [
        {
          name: 'ProbeHost',
          type: 'Runtime',
          source_path: 'H:/UnrealAgent/_ual-probe/ProbeHost/Source/ProbeHost/',
          origin: 'project'
        }
      ]
    })

    expect(text).toContain('ProbeHost')
    expect(text).toContain('共 1 个模块')
    expect(text).toContain('源码缺失')
    // 最要紧的一条：不能再说它是纯蓝图工程
    expect(text).not.toContain('这是纯蓝图工程')
  })
})
