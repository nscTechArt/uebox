/**
 * @vitest-environment node
 *
 * `blueprint_apply_graph` 的契约测试。
 *
 * 盯的是**改坏了不会有任何东西变红**的那几条性质 —— 这套工具的前一代就是
 * 这么坏掉的：schema 允许 `CallFunction`、示例里写着 `CallFunction`、插件端
 * 不认 `CallFunction`，三者互不校验，真机跑了才发现。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'

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

// ELK 布局是异步的、要拉一个真实的布局引擎。这里测的是「坐标有没有被填上」，
// 不是布局算得好不好 —— 让它回一个可预测的结果。
vi.mock('../../../../blueprint-layout/elkLayout', () => ({
  autoLayoutBlueprintNodes: vi.fn(async (nodes: Array<{ id: string }>) =>
    nodes.map((node, index) => ({ id: node.id, x: index * 400, y: 50 }))
  )
}))

import { createApplyBlueprintGraphTool } from './applyBlueprintGraph'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createApplyBlueprintGraphTool() as unknown as Executable).execute(input)

const MINIMAL = {
  blueprint_path: '/Game/BP_Door',
  nodes: [
    { id: 'begin', class: 'Event', member_name: 'ReceiveBeginPlay' },
    { id: 'print', class: 'Function', member_name: 'KismetSystemLibrary.PrintString' }
  ],
  connections: [{ from: 'begin.then', to: 'print.execute' }]
}

const okResponse = {
  ok: true,
  blueprint_path: '/Game/BP_Door.BP_Door',
  graph_name: 'EventGraph',
  created_count: 2,
  connection_count: 1,
  compiled: true,
  compile_error_count: 0,
  nodes: [
    { id: 'begin', node_id: 'GUID-1', class: 'K2Node_Event', pins: [] },
    { id: 'print', node_id: 'GUID-2', class: 'K2Node_CallFunction', pins: [] }
  ],
  diagnostics: []
}

/**
 * 写图之前会**先读一次现有图**（为了把新节点让到已有内容下面），所以
 * 打桩要按命令名分开，断言也要按命令名取调用 —— 拿 calls[0] 会拿到读那次。
 */
function mockApply(response: unknown, existingNodes: Array<{ pos_y?: number }> = []): void {
  callRequest.mockImplementation(async (command: string) =>
    command === 'blueprint.get_graph' ? { ok: true, nodes: existingNodes } : response
  )
}

/** 真正那次写入的参数 */
function writeParams(): {
  nodes: Array<{ position?: { x: number; y: number }; raw_class?: string }>
  connections: unknown[]
} {
  const call = callRequest.mock.calls.find((c) => c[0] === 'blueprint.create_graph')
  return call![1] as never
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('整图写入', () => {
  it('节点、连线、图表名一次性发给插件', async () => {
    mockApply(okResponse)

    const result = await run({ ...MINIMAL, graph_name: 'EventGraph' })

    // 节点和连线都在**同一次**写入里，没有被拆成多次
    const writes = callRequest.mock.calls.filter((c) => c[0] === 'blueprint.create_graph')
    expect(writes).toHaveLength(1)
    expect(writeParams().nodes).toHaveLength(2)
    expect(writeParams().connections).toHaveLength(1)
    expect(result.success).toBe(true)
  })

  /**
   * 前一代最贵的一个缺陷：schema 里的 `class` 是九项枚举，其中四项插件端
   * 不认，而工具示例用的恰好是不认的那个。zod 在 app 侧就把合法输入拦下，
   * 或者放过去让插件报「Unsupported node type」，两种都会把模型推回逐节点。
   *
   * 现在 class 是开放字符串：认不认由插件端一处说了算，不再有两份名单。
   */
  it('class 不做白名单校验 —— 插件认哪些由插件端一处决定', async () => {
    callRequest.mockResolvedValue({ ...okResponse, created_count: 1 })

    const result = await run({
      blueprint_path: '/Game/BP_Door',
      nodes: [{ id: 'n', class: 'CallFunction', member_name: 'KismetSystemLibrary.PrintString' }]
    })

    expect(result.success).toBe(true)
    expect(callRequest).toHaveBeenCalled()
  })

  it('raw_class 逃生口原样透传', async () => {
    mockApply({ ...okResponse, created_count: 1 })

    await run({
      blueprint_path: '/Game/BP_Door',
      nodes: [{ id: 'n', class: 'K2Node_MakeMap', raw_class: 'K2Node_MakeMap' }]
    })

    expect(writeParams().nodes[0].raw_class).toBe('K2Node_MakeMap')
  })

  /**
   * 关键帧的 interp / 切线和 length_mode 走的是 `params` 那条老路：schema 里
   * 少一个字段，zod 解析时就把它整个剥掉，请求发到插件时已经没有了，
   * 插件那头连「收到过一个不认识的字段」都不知道。所以断言盯的是
   * **发出去的那份**，不是工具返不返回成功。
   */
  it('Timeline 的轨道、插值和播放参数原样透传 —— 剥掉 interp 曲线就永远是直线', async () => {
    mockApply({ ...okResponse, created_count: 1 })

    const timeline = {
      length: 1,
      length_mode: 'length',
      autoplay: false,
      tracks: [
        {
          name: 'Alpha',
          keys: [
            { time: 0, value: 0, interp: 'auto' },
            { time: 0.5, value: 0.8, interp: 'user', arrive_tangent: 1.2, leave_tangent: 0.3 },
            { time: 1, value: 1 }
          ]
        }
      ]
    }
    await run({
      blueprint_path: '/Game/BP_Door',
      nodes: [{ id: 'tl', class: 'Timeline', member_name: 'DoorTimeline', timeline }]
    })

    const sent = writeParams().nodes[0] as { member_name?: string; timeline?: unknown }
    expect(sent.member_name).toBe('DoorTimeline')
    expect(sent.timeline).toEqual(timeline)
  })

  /**
   * 2026-09-16 的用户反馈：模型要给自定义事件加参数，`params` 和 `inputs`
   * 两种写法都试了，两种都没反应。真因在这一层 —— schema 里没有这个字段，
   * zod 解析时把它整个剥掉，请求发到插件时已经没有参数了，插件那头
   * 连「收到过一个不认识的字段」都不知道。
   *
   * 所以这条断言盯的是**发出去的那份**里还有没有 params，不是工具返不返回成功。
   */
  it('CustomEvent 的 params 原样透传 —— 剥掉它自定义事件就永远没有引脚', async () => {
    mockApply({ ...okResponse, created_count: 1 })

    const params = [
      { name: 'Opener', type: 'object', object_class: 'Actor' },
      { name: 'Delay', type: 'float' },
      { name: 'Tags', type: 'name', container: 'array' }
    ]
    await run({
      blueprint_path: '/Game/BP_Door',
      nodes: [{ id: 'ev', class: 'CustomEvent', member_name: 'OnDoorOpened', params }]
    })

    const sent = writeParams().nodes[0] as { params?: unknown }
    expect(sent.params).toEqual(params)
  })

  it('没给坐标时在 app 侧算好布局再发下去', async () => {
    // 空图：没有已有内容要让，坐标就是布局器算出来的原值
    mockApply(okResponse)

    await run(MINIMAL)

    expect(writeParams().nodes[0].position).toEqual({ x: 0, y: 50 })
    expect(writeParams().nodes[1].position).toEqual({ x: 400, y: 50 })
  })

  /**
   * 布局只认得这次要建的节点，对图里已有什么一无所知。不让开的话，
   * 分多次往同一张图里写就会后一批盖在前一批身上 —— 真机上
   * Event ActorBeginOverlap 就这么压在了 Set Actor Rotation 上。
   */
  it('图里已有节点时，新一批整体往下让开', async () => {
    // 第一次调用是读现有图，第二次才是写
    mockApply(okResponse, [{ pos_y: 600 }, { pos_y: 200 }])

    await run(MINIMAL)

    // 已有内容最低到 600，新节点要落在它下面
    expect(writeParams().nodes[0].position!.y).toBeGreaterThan(600)
  })

  it('clear_existing 时不用让 —— 反正要清空', async () => {
    mockApply(okResponse)

    await run({ ...MINIMAL, clear_existing: true })

    // 没有额外的读图请求
    expect(callRequest.mock.calls.filter((c) => c[0] === 'blueprint.get_graph')).toHaveLength(0)
    expect(writeParams().nodes[0].position).toEqual({ x: 0, y: 50 })
  })

  it('读现有图失败时退回旧行为，不让写图整个失败', async () => {
    callRequest.mockImplementation(async (command: string) => {
      if (command === 'blueprint.get_graph') throw new Error('boom')
      return okResponse
    })

    const result = await run(MINIMAL)

    expect(result.success).toBe(true)
  })

  it('调用方自己给了坐标就不覆盖', async () => {
    callRequest.mockResolvedValue({ ...okResponse, created_count: 1 })

    await run({
      blueprint_path: '/Game/BP_Door',
      nodes: [
        { id: 'n', class: 'Event', member_name: 'ReceiveBeginPlay', position: { x: 7, y: 9 } }
      ]
    })

    const params = callRequest.mock.calls[0][1] as {
      nodes: Array<{ position?: { x: number; y: number } }>
    }
    expect(params.nodes[0].position).toEqual({ x: 7, y: 9 })
  })
})

/**
 * 空 nodes = 「两个已有节点之间补一根线」。
 *
 * 在此之前 schema 卡 `.min(1)`，补一根线得先塞一个用不上的节点陪跑、连完再删 ——
 * 两次调用做一件事。放开之后要守住的是它**不能**和 clear_existing 同时出现：
 * 那个组合等于把整张图清空、什么都不建。
 */
describe('只补连线', () => {
  it('nodes 为空时照样发得出去，连线原样透传', async () => {
    mockApply({ ...okResponse, created_count: 0, connection_count: 1, nodes: [] })

    const result = await run({
      blueprint_path: '/Game/BP_Door',
      nodes: [],
      connections: [{ from: 'GUID-1.then', to: 'GUID-2.execute' }]
    })

    expect(result.success).toBe(true)
    expect(writeParams().nodes).toHaveLength(0)
    expect(writeParams().connections).toHaveLength(1)
  })

  /** 没有节点就没有要排的版，别为此多打一次 get_graph */
  it('nodes 为空时不去读现有图算布局', async () => {
    mockApply({ ...okResponse, created_count: 0, connection_count: 1, nodes: [] })

    await run({
      blueprint_path: '/Game/BP_Door',
      nodes: [],
      connections: [{ from: 'GUID-1.then', to: 'GUID-2.execute' }]
    })

    expect(callRequest.mock.calls.filter((c) => c[0] === 'blueprint.get_graph')).toHaveLength(0)
  })

  /**
   * 断言打在 schema 上而不是 execute 上：校验发生在适配层（adaptV2Tool 用
   * inputSchema 解析入参），execute 拿到的已经是解析过的。
   */
  it('空 nodes 配 clear_existing 会清空整张图，schema 直接拒掉', () => {
    const schema = (createApplyBlueprintGraphTool() as unknown as { inputSchema: z.ZodTypeAny })
      .inputSchema

    const rejected = schema.safeParse({
      blueprint_path: '/Game/BP_Door',
      nodes: [],
      clear_existing: true
    })
    expect(rejected.success).toBe(false)

    // 单独出现的两个都还是合法的，别把正常用法一起挡了
    expect(schema.safeParse({ blueprint_path: '/Game/BP_Door', nodes: [] }).success).toBe(true)
    expect(
      schema.safeParse({
        blueprint_path: '/Game/BP_Door',
        nodes: [{ id: 'n', class: 'Event', member_name: 'ReceiveBeginPlay' }],
        clear_existing: true
      }).success
    ).toBe(true)
  })
})

describe('失败即回滚', () => {
  /**
   * 「图没动过」这件事必须写进给模型看的文字里。
   *
   * 前一代失败时留下半张图（ok:false 配 created_count:1 还编译了），模型
   * 拿到之后得先查图搞清楚残骸，多半直接放弃批量。现在整批回滚，但如果
   * 不明说，模型仍会按老经验去「补上失败的那几个」—— 那会建出重复节点。
   */
  it('回滚时明确告诉调用方图没变、要重发整份', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      rolled_back: true,
      blueprint_path: '/Game/BP_Door.BP_Door',
      graph_name: 'EventGraph',
      created_count: 0,
      connection_count: 0,
      compiled: false,
      errors: ["nodes[1] 'print': Function not found: PrintStrng (did you mean: PrintString?)"]
    })

    const result = await run(MINIMAL)

    expect(result.success).toBe(false)
    expect(result.rolled_back).toBe(true)
    expect(String(result.error)).toContain('回滚')
    expect(String(result.error)).toContain('完整')
    // 具体哪条错也要带上，否则模型只知道失败了不知道改哪
    expect(String(result.error)).toContain('PrintString')
  })

  it('每条错误都编号列出，不是糊成一句', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      rolled_back: true,
      blueprint_path: '/Game/BP_Door.BP_Door',
      graph_name: 'EventGraph',
      created_count: 0,
      connection_count: 0,
      compiled: false,
      errors: ['nodes[0]: bad', 'connections[2]: worse']
    })

    const result = await run(MINIMAL)

    expect(String(result.error)).toContain('1. nodes[0]: bad')
    expect(String(result.error)).toContain('2. connections[2]: worse')
  })

  /**
   * 同一批里 wildcard 不会跟着定型：命令是「全验完再一次性连」，
   * 而 ForEach 的 Array Element 要等 Array 引脚**真的连上**才定型。
   * 图本身是对的，只是得分两次发 —— 不说的话模型会去改节点类型，越改越远。
   */
  it('两端都是 wildcard 的连线被拒时，指路「分两批发」', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      rolled_back: true,
      blueprint_path: '/Game/BP_Door.BP_Door',
      graph_name: 'EventGraph',
      created_count: 0,
      connection_count: 0,
      compiled: false,
      errors: [
        "connections[15]: cannot connect 'foreach.Array Element' (wildcard Output) -> " +
          "'cast.Object' (wildcard Input): 仅可以转换对象/接口的类型。"
      ]
    })

    const result = await run(MINIMAL)

    expect(String(result.error)).toContain('分两批发')
    expect(String(result.error)).toContain('nodes=[]')
  })

  it('普通类型不匹配不加这条提示 —— 那种确实是写错了', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      rolled_back: true,
      blueprint_path: '/Game/BP_Door.BP_Door',
      graph_name: 'EventGraph',
      created_count: 0,
      connection_count: 0,
      compiled: false,
      errors: [
        "connections[3]: cannot connect 'a.Out' (float Output) -> 'b.In' (string Input): 类型不匹配"
      ]
    })

    const result = await run(MINIMAL)

    expect(String(result.error)).not.toContain('分两批发')
  })
})

describe('引擎自作主张的副作用', () => {
  /**
   * 连线时引擎会替你做一些没要求的事：顶掉目标引脚上已有的连线、插一个类型
   * 转换节点、提升引脚类型。这些如果只塞在字段里不写进 summary，模型多半
   * 不会看 —— 然后它以为写成了 A，图里其实是 B，下一轮读回来又对不上。
   */
  it('warnings 要带上，并且在 summary 里点名', async () => {
    callRequest.mockResolvedValue({
      ...okResponse,
      warnings: [
        "connections[0] 'a.then' -> 'b.execute': replaced an existing connection on that pin"
      ]
    })

    const result = await run(MINIMAL)

    expect(result.success).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(String(result.summary)).toContain('引擎自动调整')
  })

  it('没有副作用时不塞空的 warnings 字段', async () => {
    callRequest.mockResolvedValue(okResponse)

    const result = await run(MINIMAL)

    expect(result).not.toHaveProperty('warnings')
    expect(String(result.summary)).not.toContain('引擎自动调整')
  })

  /**
   * UE 的事务在 GEditor 缺席或正忙时会静默降级成空操作，那种情况下用户
   * Ctrl+Z 撤不回来。这件事必须说 —— 「以为能撤销」和「真的能撤销」
   * 在用户决定要不要先存一份时是完全不同的信息。
   */
  it('撤销不可用时如实说，而不是默认当成可撤销', async () => {
    callRequest.mockResolvedValue({ ...okResponse, undoable: false })

    const result = await run(MINIMAL)

    expect(result.undoable).toBe(false)
    expect(String(result.summary)).toContain('Ctrl+Z')
  })

  it('可撤销是常态，不用额外啰嗦', async () => {
    callRequest.mockResolvedValue({ ...okResponse, undoable: true })

    const result = await run(MINIMAL)

    expect(result).not.toHaveProperty('undoable')
    expect(String(result.summary)).not.toContain('Ctrl+Z')
  })
})

describe('编译诊断', () => {
  /**
   * 编译失败**不算**调用失败：图确实写进去了。
   *
   * 报成 success:false 会让模型以为整张图没写成，然后重写一遍 —— 而实际上
   * 多半只要改一两个节点。这个区别直接决定了修复要几个来回。
   */
  it('编译有错时仍算写入成功，诊断照原样带上', async () => {
    callRequest.mockResolvedValue({
      ...okResponse,
      compile_error_count: 1,
      diagnostics: [
        {
          severity: 'error',
          message: 'Condition pin is not connected',
          node: 'check',
          node_id: 'GUID-3'
        }
      ]
    })

    const result = await run(MINIMAL)

    expect(result.success).toBe(true)
    expect(result.diagnostics).toHaveLength(1)
    // 诊断挂的是调用方自己写的 id，不是引擎 GUID —— 模型手里只有前者
    expect((result.diagnostics as Array<{ node?: string }>)[0].node).toBe('check')
    expect(String(result.summary)).toContain('1 个错误')
  })

  it('编译通过时不塞空的 diagnostics 字段', async () => {
    callRequest.mockResolvedValue(okResponse)

    const result = await run(MINIMAL)

    expect(result).not.toHaveProperty('diagnostics')
    expect(String(result.summary)).toContain('编译通过')
  })
})

describe('连不上引擎', () => {
  it('没有连接时直说，不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await run(MINIMAL)

    expect(result.success).toBe(false)
    // 断言落在「说清没连上 + 给出下一步」上，不落在具体措辞上：
    // 这句话的来源是共用常量 UE_NOT_CONNECTED_MESSAGE（`tools/defineUeTool.ts`）
    expect(String(result.error)).toContain('引擎未连接')
    expect(String(result.error)).toContain('ue_session_health')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('插件无响应时不把 undefined 当成成功', async () => {
    callRequest.mockResolvedValue(undefined)

    const result = await run(MINIMAL)

    expect(result.success).toBe(false)
  })
})
