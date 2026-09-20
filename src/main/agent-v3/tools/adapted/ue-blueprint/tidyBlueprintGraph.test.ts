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

// 只把「算坐标」这一步换掉（要的是可预测的结果），分列和「该复制哪些 getter」
// 用真的 —— 那两步的结论要跟着真实算法走，假一个出来等于什么都没测
vi.mock('../../../../blueprint-layout/blueprintLayout', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../blueprint-layout/blueprintLayout')>()
  return { ...actual, autoLayoutBlueprintNodes: (...args: unknown[]) => autoLayout(...args) }
})

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

/**
 * 一条五节点的执行链，外加一个被**头尾两处**用到的变量读取节点。
 * 只挪位置的话，那根线必然横跨整张图 —— 手排图的人会在尾巴那头再拖一个 Get。
 */
const GRAPH_WITH_FAR_GETTER = {
  ok: true,
  graph_name: 'EventGraph',
  nodes: [
    ...['A', 'B', 'C', 'D', 'E'].map((id, index, all) => ({
      node_id: `GUID-${id}`,
      class: 'K2Node_CallFunction',
      title: `节点${id}`,
      pos_x: 0,
      pos_y: 0,
      pins: [
        ...(index > 0
          ? [
              {
                name: 'execute',
                dir: 'Input',
                category: 'exec',
                linked_to: [{ node_id: `GUID-${all[index - 1]}`, pin_name: 'then' }]
              }
            ]
          : []),
        ...(index < all.length - 1
          ? [
              {
                name: 'then',
                dir: 'Output',
                category: 'exec',
                linked_to: [{ node_id: `GUID-${all[index + 1]}`, pin_name: 'execute' }]
              }
            ]
          : []),
        ...(id === 'B' || id === 'E'
          ? [
              {
                name: 'Value',
                dir: 'Input',
                category: 'real',
                linked_to: [{ node_id: 'GUID-GET', pin_name: 'Speed' }]
              }
            ]
          : [])
      ]
    })),
    {
      node_id: 'GUID-GET',
      class: 'K2Node_VariableGet',
      title: 'Speed',
      write_as: 'VariableGet',
      member_name: 'Speed',
      pos_x: 0,
      pos_y: 0,
      pins: [
        {
          name: 'Speed',
          dir: 'Output',
          category: 'real',
          linked_to: [
            { node_id: 'GUID-B', pin_name: 'Value' },
            { node_id: 'GUID-E', pin_name: 'Value' }
          ]
        }
      ]
    }
  ]
}

describe('就近复制纯 getter', () => {
  /**
   * 一个节点出现在一处，却要喂三个相距很远的地方 —— 怎么摆都有长线，
   * 这不是排版能解决的。纯节点本来就按消费者各求值一次，复制前后完全等价。
   */
  it('被远处用到的变量读取会就近复制一份，并把那根线接到拷贝上', async () => {
    callRequest
      .mockResolvedValueOnce(GRAPH_WITH_FAR_GETTER) // 读图
      .mockResolvedValueOnce({ ok: true, created_count: 1 }) // 建拷贝
      .mockResolvedValueOnce(GRAPH_WITH_FAR_GETTER) // 复制完重新读
      .mockResolvedValueOnce({ ok: true, moved: 6 })

    const result = await run()

    const [command, params] = callRequest.mock.calls[1]
    expect(command).toBe('blueprint.create_graph')
    const payload = params as {
      nodes: Array<Record<string, unknown>>
      connections: Array<{ from: string; to: string }>
      compile: boolean
    }
    expect(payload.nodes).toHaveLength(1)
    expect(payload.nodes[0]).toMatchObject({ class: 'VariableGet', member_name: 'Speed' })
    // 拷贝接管的是**右边那一处**，左边那处留给原节点
    expect(payload.connections).toEqual([
      { from: `${String(payload.nodes[0].id)}.Speed`, to: 'GUID-E.Value' }
    ])
    // 只是多读了一次变量，没什么可编译的
    expect(payload.compile).toBe(false)

    expect(result.duplicated_getters).toEqual([{ name: 'Speed', copies: 1 }])
    expect(String(result.summary)).toContain('就近复制了 1 个纯 getter')
  })

  it('duplicate_getters: false 时一个节点都不建', async () => {
    callRequest
      .mockResolvedValueOnce(GRAPH_WITH_FAR_GETTER)
      .mockResolvedValueOnce({ ok: true, moved: 6 })

    const result = await run({ blueprint_path: '/Game/BP_Door', duplicate_getters: false })

    expect(callRequest.mock.calls.map((call) => call[0])).toEqual([
      'blueprint.get_graph',
      'blueprint.set_node_positions'
    ])
    expect(result.duplicated_getters).toBeUndefined()
  })

  /** 只隔一两列的不值得复制 —— 那根线本来就很短，复制只会让图里多一个节点 */
  it('消费者挨得近就不复制', async () => {
    const close = {
      ...GRAPH_WITH_FAR_GETTER,
      nodes: GRAPH_WITH_FAR_GETTER.nodes.map((node) =>
        node.node_id === 'GUID-GET'
          ? {
              ...node,
              pins: [
                {
                  ...node.pins[0],
                  linked_to: [
                    { node_id: 'GUID-B', pin_name: 'Value' },
                    { node_id: 'GUID-C', pin_name: 'Value' }
                  ]
                }
              ]
            }
          : node
      )
    }
    callRequest.mockResolvedValueOnce(close).mockResolvedValueOnce({ ok: true, moved: 6 })

    await run()

    expect(callRequest.mock.calls.map((call) => call[0])).not.toContain('blueprint.create_graph')
  })

  /**
   * 复制失败不能把整理也拖下水 —— 排版本身还是有价值的。
   * 但也不能装作复制成功了，用户会以为长线已经解决。
   */
  it('复制失败时照常排版，且不谎报复制过', async () => {
    callRequest
      .mockResolvedValueOnce(GRAPH_WITH_FAR_GETTER)
      .mockResolvedValueOnce({ ok: false, error: '建不出来' })
      .mockResolvedValueOnce({ ok: true, moved: 6 })

    const result = await run()

    expect(result.success).toBe(true)
    expect(result.duplicated_getters).toBeUndefined()
    expect(String(result.summary)).not.toContain('就近复制')
  })
})

describe('不该被排版碰的东西', () => {
  /** 注释框是框，不是节点 —— 它不参与节点排版，也不该出现在 positions 里 */
  it('注释框不跟普通节点一起排，也不写进坐标表', async () => {
    const withComment = {
      ...GRAPH,
      nodes: [
        ...GRAPH.nodes,
        {
          node_id: 'GUID-COMMENT',
          class: 'EdGraphNode_Comment',
          title: '这一段在算间距',
          pos_x: 40,
          pos_y: -120,
          pins: []
        }
      ]
    }
    callRequest.mockResolvedValueOnce(withComment).mockResolvedValueOnce({ ok: true, moved: 3 })

    const result = await run()

    const [layoutNodes] = autoLayout.mock.calls[0] as [Array<{ id: string }>]
    expect(layoutNodes.map((node) => node.id)).toEqual(['GUID-A', 'GUID-B', 'GUID-C'])

    const [, params] = callRequest.mock.calls[1]
    const positions = (params as { positions: Array<{ node_id: string }> }).positions
    expect(positions.some((position) => position.node_id === 'GUID-COMMENT')).toBe(false)
    // 这个框没有尺寸、也没有名单，谁在里面根本判不出来 —— 那就别动它
    expect(String(result.summary)).toContain('没框住任何节点')
  })

  /**
   * 不挪框的代价：图整理完，用户手写的「这一段在算间距」还贴在原处，
   * 指着一片空白 —— 比排乱更糟，因为它看起来还是对的。
   */
  it('框住了节点的注释框跟着那段逻辑一起挪', async () => {
    const withComment = {
      ...GRAPH,
      nodes: [
        ...GRAPH.nodes,
        {
          node_id: 'GUID-COMMENT',
          class: 'EdGraphNode_Comment',
          title: '这一段在算间距',
          comment_text: '这一段在算间距',
          pos_x: -50,
          pos_y: -50,
          node_width: 600,
          node_height: 400,
          pins: []
        }
      ]
    }
    callRequest
      .mockResolvedValueOnce(withComment)
      .mockResolvedValueOnce({ ok: true, moved: 3 })
      .mockResolvedValueOnce({ ok: true, node_id: 'GUID-COMMENT' })

    const result = await run()

    const [command, params] = callRequest.mock.calls[2]
    expect(command).toBe('blueprint.set_comment')
    const payload = params as {
      node_id: string
      bounds: { x: number; y: number; width: number; height: number }
      enclose_nodes: string[]
    }
    expect(payload.node_id).toBe('GUID-COMMENT')
    // 三个节点排在 (0,100) (400,100) (800,100)，框要把它们整个圈进去
    expect(payload.bounds.x).toBeLessThan(0)
    expect(payload.bounds.width).toBeGreaterThan(800)
    // 名单也要补上：引擎靠它决定「用户拖动这个框时带走谁」
    expect(payload.enclose_nodes).toEqual(['GUID-A', 'GUID-B', 'GUID-C'])
    expect(result.comments_moved).toBe(1)
    expect(String(result.summary)).toContain('注释框跟着它框住的逻辑一起挪')
  })

  /**
   * 引脚名猜不准：`Update Rate`、`bLoop` 这种数据引脚一被当成执行引脚，
   * 整张图的分层就从那根线开始歪。类型本来就在手里，别猜。
   */
  it('按引脚类型告诉布局器哪根是执行线', async () => {
    const typed = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((node) => ({
        ...node,
        pins: node.pins.map((pin) => ({ ...pin, category: 'exec' }))
      }))
    }
    callRequest.mockResolvedValueOnce(typed).mockResolvedValueOnce({ ok: true, moved: 3 })

    await run()

    const [, connections] = autoLayout.mock.calls[0] as [unknown, Array<{ kind?: string }>]
    expect(connections.every((connection) => connection.kind === 'exec')).toBe(true)
  })

  it('排完的图留在原来的位置，不跳回坐标原点', async () => {
    callRequest.mockResolvedValueOnce(GRAPH).mockResolvedValueOnce({ ok: true, moved: 3 })

    await run()

    const [, , options] = autoLayout.mock.calls[0] as [unknown, unknown, { anchor?: string }]
    expect(options?.anchor).toBe('original')
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
