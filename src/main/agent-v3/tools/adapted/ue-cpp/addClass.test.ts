/**
 * @vitest-environment node
 *
 * 建类之后模型最容易在三个地方走错：
 *   - 以为建完就能用 —— 插件只写文件不编译，漏掉 cpp_compile 就会纳闷新类为什么不出现；
 *   - 纯蓝图工程的第一个类 —— 新模块编辑器当场加载不了，cpp_compile 没用，要 cpp_full_rebuild；
 *   - 报重名 —— 那是上一轮建过，换个名字再建一个就是第二个类。
 * 外加 AGENTS.md §5 第 14 条：文件在不在以插件读回的为准，不回显入参。
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
import { cppTools } from './index'

type Executable = {
  execute: (id: string, params: unknown) => Promise<{ content?: { text?: string }[] }>
}

const run = async (
  response: Record<string, unknown>,
  input: Record<string, unknown> = { name: 'SurvivorDirector', parent_class: 'Actor' }
): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const tool = createCppAddClassTool() as unknown as Executable
  const r = await tool.execute('c1', input)
  return (r.content ?? []).map((c) => c.text ?? '').join('\n')
}

const OK = {
  result: 'Succeeded',
  class_name: 'ASurvivorDirector',
  module: 'MyGame',
  header_path: 'H:/Dev/MyGame/Source/MyGame/SurvivorDirector.h',
  cpp_path: 'H:/Dev/MyGame/Source/MyGame/SurvivorDirector.cpp',
  header_exists: true,
  cpp_exists: true,
  created_files: [
    'H:/Dev/MyGame/Source/MyGame/SurvivorDirector.h',
    'H:/Dev/MyGame/Source/MyGame/SurvivorDirector.cpp'
  ],
  dependencies_added: [],
  created_primary_module: false,
  reloaded: false,
  warnings: []
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('cpp_add_class', () => {
  it('注册进了 cppTools —— 不再让用户去菜单里手动建', () => {
    const names = cppTools().map((t) => t.name)
    expect(names).toContain('cpp_add_class')
    expect(names).toContain('cpp_full_rebuild')
  })

  it('描述里明说别让用户点菜单、也别自己拼文件', () => {
    const tool = createCppAddClassTool() as unknown as { description: string }
    expect(tool.description).toContain('别让用户去编辑器里点')
    expect(tool.description).toContain('write_local_file')
  })

  it('参数原样传给 cpp.add_class，location 有默认值', async () => {
    await run(OK)

    expect(callRequest.mock.calls[0][0]).toBe('cpp.add_class')
    expect(callRequest.mock.calls[0][1]).toEqual({
      name: 'SurvivorDirector',
      parent_class: 'Actor',
      location: 'default'
    })
  })

  it('成功：带前缀的类名、两个路径，并要求接下来填实现再 cpp_compile', async () => {
    const text = await run(OK)

    expect(text.startsWith('✓')).toBe(true)
    expect(text).toContain('ASurvivorDirector')
    expect(text).toContain('SurvivorDirector.h')
    expect(text).toContain('SurvivorDirector.cpp')
    expect(text).toContain('还没有编译')
    expect(text).toContain('cpp_compile')
    expect(text).not.toContain('cpp_full_rebuild')
  })

  it('纯蓝图工程的第一个类：列出主模块文件，下一步是 cpp_full_rebuild 而不是 cpp_compile', async () => {
    const text = await run({
      ...OK,
      created_primary_module: true,
      created_files: [
        'H:/Dev/MyGame/Source/MyGame.Target.cs',
        'H:/Dev/MyGame/Source/MyGameEditor.Target.cs',
        'H:/Dev/MyGame/Source/MyGame/MyGame.Build.cs',
        ...OK.created_files
      ]
    })

    expect(text).toContain('主模块')
    expect(text).toContain('MyGameEditor.Target.cs')
    expect(text).toContain('cpp_full_rebuild')
    expect(text).toContain('加载不了')
  })

  /** 回执跟着引擎走：插件读回说文件不在，就不能开口说建好了（AGENTS.md §5 第 14 条） */
  it('插件读回文件不在时，第一句不说成功', async () => {
    const text = await run({ ...OK, cpp_exists: false })

    expect(text.startsWith('✓')).toBe(false)
    expect(text).toContain('找不到')
    expect(text).toContain('SurvivorDirector.cpp')
  })

  it('名字带了前缀时说明没有再加一层，用插件给的最终类名', async () => {
    const text = await run(
      { ...OK, requested_name: 'ASurvivorDirector' },
      { name: 'ASurvivorDirector', parent_class: 'Actor' }
    )

    expect(text).toContain('没有再加一层')
    expect(text).not.toContain('AASurvivorDirector')
  })

  it('接口类说明实现方继承哪个 I 类', async () => {
    const text = await run({
      ...OK,
      class_name: 'UDamageable',
      interface_name: 'IDamageable'
    })

    expect(text).toContain('IDamageable')
  })

  it('登记了模块依赖和有警告时都摆出来', async () => {
    const text = await run({
      ...OK,
      dependencies_added: ['UMG'],
      warnings: ['父类所在模块没能登记进 .uproject（只读）']
    })

    expect(text).toContain('UMG')
    expect(text).toContain('只读')
  })

  /**
   * 重名、类名不合法这些插件走 4xx 带原话 —— callUe 当场抛，熔断器看得见，
   * 同一组参数不会被无限重试。原话（含「别换名字重建」）要原样到模型手里。
   */
  it('插件拒绝时把原话抛出来', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      __rpc: { code: 409 },
      error:
        '类 SurvivorDirector 已经存在：H:/Dev/MyGame/Source/MyGame/SurvivorDirector.h。不要换个名字重建'
    })
    const tool = createCppAddClassTool() as unknown as Executable

    await expect(
      tool.execute('c1', { name: 'SurvivorDirector', parent_class: 'Actor' })
    ).rejects.toThrow('不要换个名字重建')
  })
})
