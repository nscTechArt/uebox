/**
 * @vitest-environment node
 *
 * `blueprint_tidy_graph` 的契约测试。
 *
 * 最要紧的一条：**连线必须从 `pins[].linked_to` 推出来**。插件的
 * `blueprint.get_graph` 不回顶层 connections 数组，忘了推的话 ELK 拿到零条边，
 * 排出来是一堆互不相干的方块 —— 比不排还难看，而且不会有任何报错。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)
const autoLayout = vi.fn()

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

vi.mock('../../../../blueprint-layout/elkLayout', () => ({
  autoLayoutBlueprintNodes: (...args: unknown[]) => autoLayout(...args)
}))

import { createTidyBlueprintGraphTool } from './tidyBlueprintGraph'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown = { blueprint_path: '/Game/BP_Door' }): Promise<ToolResult> =>
  (createTidyBlueprintGraphTool() as unknown as Executable).execute(input)

/** 三个节点、两条线：BeginPlay -> Branch -> Print */
const GRAPH = {
  ok: true,
  graph_name: 'EventGraph',
  nodes: [
    {
      node_id: 'GUID-A',
      class: 'K2Node_Event',
      title: '事件开始运行',
      pos_x: 0,
      pos_y: 0,
      pins: [
        {
          name: 'then',
          dir: 'Output',
          linked_to: [{ node_id: 'GUID-B', pin_name: 'execute' }]
        }
      ]
    },
    {
      node_id: 'GUID-B',
      class: 'K2Node_IfThenElse',
      title: '分支',
      pos_x: 0,
      pos_y: 0,
      pins: [
        { name: 'execute', dir: 'Input', linked_to: [{ node_id: 'GUID-A', pin_name: 'then' }] },
        { name: 'then', dir: 'Output', linked_to: [{ node_id: 'GUID-C', pin_name: 'execute' }] }
      ]
    },
    {
      node_id: 'GUID-C',
      class: 'K2Node_CallFunction',
      title: '打印字符串',
      pos_x: 0,
      pos_y: 0,
      pins: [
        { name: 'execute', dir: 'Input', linked_to: [{ node_id: 'GUID-B', pin_name: 'then' }] }
      ]
    }
  ]
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset()
  getConnectionCount.mockReturnValue(1)
  autoLayout.mockReset()
  autoLayout.mockImplementation(async (nodes: Array<{ id: string }>) =>
    nodes.map((node, index) => ({ id: node.id, x: index * 400, y: 100 }))
  )
})

describe('排版', () => {
  /**
   * 这条是整个文件的重点。连线推错或者忘了推，ELK 就没有边可用，
   * 结果是「排过了但还是乱」—— 没有任何报错，只能靠肉眼发现。
   */
  it('从 linked_to 推出连线喂给布局器，只从输出侧发出一次', async () => {
    callRequest.mockResolvedValueOnce(GRAPH).mockResolvedValueOnce({ ok: true, moved: 3 })

    await run()

    const [, connections] = autoLayout.mock.calls[0]
    // 两条线，不是四条 —— 每根线在两端的 linked_to 里各出现一次，
    // 两侧都收会得到重复的边
    expect(connections).toEqual([
      { from: 'GUID-A.then', to: 'GUID-B.execute' },
      { from: 'GUID-B.then', to: 'GUID-C.execute' }
    ])
  })

  it('把算好的坐标写回插件', async () => {
    callRequest.mockResolvedValueOnce(GRAPH).mockResolvedValueOnce({ ok: true, moved: 3 })

    const result = await run()

    const [command, params] = callRequest.mock.calls[1]
    expect(command).toBe('blueprint.set_node_positions')
    expect((params as { positions: unknown[] }).positions).toEqual([
      { node_id: 'GUID-A', x: 0, y: 100 },
      { node_id: 'GUID-B', x: 400, y: 100 },
      { node_id: 'GUID-C', x: 800, y: 100 }
    ])
    expect(result.success).toBe(true)
    expect(result.moved).toBe(3)
  })

  it('节点太少时直接跳过，不白改一次脏状态', async () => {
    callRequest.mockResolvedValueOnce({ ...GRAPH, nodes: GRAPH.nodes.slice(0, 2) })

    const result = await run()

    expect(result.success).toBe(true)
    expect(result.moved).toBe(0)
    // 只读了一次图，没有发写入请求
    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(String(result.summary)).toContain('不需要排版')
  })

  it('结论里说明逻辑没被改动 —— 这是用户最担心的一点', async () => {
    callRequest.mockResolvedValueOnce(GRAPH).mockResolvedValueOnce({ ok: true, moved: 3 })

    const result = await run()

    expect(String(result.summary)).toContain('逻辑没有任何改动')
  })

  /**
   * 有节点没挪到，多半是拿着一份过期的图在算坐标。要报出来，
   * 否则「成功挪了 2 个」会盖掉真正的问题。
   */
  it('有节点没找到时带上并说明可能过期', async () => {
    callRequest
      .mockResolvedValueOnce(GRAPH)
      .mockResolvedValueOnce({ ok: false, moved: 2, not_found: ['GUID-C'] })

    const result = await run()

    expect(result.not_found).toEqual(['GUID-C'])
    expect(String(result.summary)).toContain('没找到')
  })
})

describe('异常', () => {
  it('图是空的时候算失败', async () => {
    callRequest.mockResolvedValueOnce({ ok: true, nodes: [] })

    const result = await run()

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('一个节点都没有')
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await run()

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})
