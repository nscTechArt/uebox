/**
 * @vitest-environment node
 *
 * PCG 工具集。
 *
 * 引擎侧那半（反射调 PCG）没法在这里测 —— 它要一个真的跑着 PCG 的编辑器。
 * 这里测的是这一层能自己保证的三件事：
 *   1. 工具都注册了，风险等级标对了（标错会让 auto-edit 档静默改用户的图）
 *   2. 参数确实按约定的字段名传到 RPC（字段名漂了会变成运行时的静默失败）
 *   3. 返回值被翻译成模型看得懂的话，尤其是「跑完了但什么都没生成」这种
 *      成功状态码 + 失败语义的情况
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { pcgTools } from './index'

interface AgentResult {
  content: Array<{ type: string; text?: string }>
  details?: unknown
}

type Executable = {
  name: string
  unrealBox: { namespace: string; risk: string }
  execute: (id: string, input: unknown) => Promise<AgentResult>
}

const byName = (name: string): Executable => {
  const found = (pcgTools as unknown as Executable[]).find((t) => t.name === name)
  if (!found) throw new Error(`工具未注册：${name}`)
  return found
}

/** 模型实际看到的只有 content 里的文本，断言要对着它而不是内部 details */
const textOf = (result: AgentResult): string =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')

it('场景报告把坐标和半长的单位直接交给模型', async () => {
  callRequest.mockResolvedValueOnce({
    level_package: '/Game/Test',
    level_name: 'Test',
    world_partition: false,
    unsaved_temp_level: false,
    landscape: { main_landscapes: 0, streaming_proxies_loaded: 0, names: [] },
    pcg_volumes: [
      { actor_label: 'Volume', center: { x: 100, y: 200, z: 300 }, extent: { x: 50, y: 60, z: 70 } }
    ],
    notes: []
  })
  const result = await byName('pcg_scene_report').execute('t', {})
  expect(textOf(result)).toContain('world 世界空间')
  expect(textOf(result)).toContain('center (100, 200, 300) 厘米')
  expect(textOf(result)).toContain('extent（半长）(50, 60, 70) 厘米')
  expect(result.details).toMatchObject({
    geometry: { space: 'world', length_unit: 'cm', extent: 'half_size' }
  })
})

const lastCall = (): { method: string; params: Record<string, unknown> } => {
  const [method, params] = callRequest.mock.calls.at(-1) as [string, Record<string, unknown>]
  return { method, params }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('注册与风险等级', () => {
  it('18 个工具全部在 ue.pcg 命名空间下', () => {
    expect(pcgTools).toHaveLength(18)
    for (const tool of pcgTools as unknown as Executable[]) {
      expect(tool.unrealBox.namespace).toBe('ue.pcg')
    }
  })

  it.each([
    'pcg_status',
    'pcg_get_graph',
    'pcg_list_node_types',
    'pcg_get_node_schema',
    'pcg_diagnose',
    'pcg_scene_report',
    'pcg_describe_node'
  ])('%s 是只读的，不该触发审批', (name) => {
    expect(byName(name).unrealBox.risk).toBe('safe')
  })

  it.each([
    'pcg_create_graph',
    'pcg_apply_graph',
    'pcg_add_node',
    'pcg_update_node',
    'pcg_remove_node',
    'pcg_connect_pins',
    'pcg_disconnect_pins',
    'pcg_spawn_volume',
    'pcg_execute',
    'pcg_tidy_graph'
  ])('%s 会改东西，标 mutating', (name) => {
    expect(byName(name).unrealBox.risk).toBe('mutating')
  })

  /**
   * 整图写入和逐节点写入并发跑同一张图会互相覆盖 —— 后写的那次拿的是过期快照。
   * 这两个必须是串行的。
   */
  it.each(['pcg_apply_graph', 'pcg_tidy_graph', 'pcg_execute'])('%s 是串行执行', (name) => {
    const tool = byName(name) as unknown as { executionMode?: string }
    expect(tool.executionMode).toBe('sequential')
  })
})

describe('pcg_apply_graph', () => {
  it('节点、连线、路径属性一次传给引擎', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      nodes: [{ alias: 'spawner', node_id: 'PCGStaticMeshSpawner_0', type: 'X' }],
      edges: [{ from: 'sampler', from_pin: 'Out', to: 'spawner', to_pin: 'In' }],
      graph_edges_after: []
    })

    await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/G',
      nodes: [
        {
          id: 'spawner',
          type: 'PCGStaticMeshSpawnerSettings',
          properties: {
            'MeshSelectorParameters.MeshEntries[0].Descriptor.StaticMesh': '/Game/Trees/SM_Oak',
            'MeshSelectorParameters.MeshEntries[0].Weight': 5
          }
        }
      ],
      edges: [{ from: 'spawner', to: 'Output' }]
    })

    const { method, params } = lastCall()
    expect(method).toBe('pcg.apply_graph')
    // 嵌套路径必须原样透传，中途被规范化或截断都会静默写错地方
    expect(params).toMatchObject({
      nodes: [
        {
          id: 'spawner',
          properties: {
            'MeshSelectorParameters.MeshEntries[0].Descriptor.StaticMesh': '/Game/Trees/SM_Oak',
            'MeshSelectorParameters.MeshEntries[0].Weight': 5
          }
        }
      ],
      edges: [{ from: 'spawner', to: 'Output' }]
    })
  })

  it('连线不填引脚名时不自己编默认值', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      nodes: [],
      edges: [],
      graph_edges_after: []
    })

    await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/G',
      edges: [{ from: 'Input', to: 'sampler' }]
    })

    const { params } = lastCall()
    const edges = params.edges as Array<Record<string, unknown>>
    // 图的 Input 节点输出引脚叫 "In"、Output 节点输入引脚叫 "Out"，跟直觉相反。
    // 任何写死的默认值在这两个端点上都是错的，只能由引擎侧按实际引脚去定
    expect(edges[0].from_pin).toBeUndefined()
    expect(edges[0].to_pin).toBeUndefined()
  })

  it('把写完之后图里的全部连线报出来，省掉再读一次', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      nodes: [
        { alias: 'sampler', node_id: 'PCGSurfaceSampler_0', type: 'PCGSurfaceSamplerSettings' }
      ],
      edges: [{ from: 'Input', from_pin: 'In', to: 'sampler', to_pin: 'In' }],
      graph_edges_after: [
        {
          from_node: 'DefaultInputNode',
          from_pin: 'In',
          to_node: 'PCGSurfaceSampler_0',
          to_pin: 'In'
        },
        {
          from_node: 'PCGSurfaceSampler_0',
          from_pin: 'Out',
          to_node: 'DefaultOutputNode',
          to_pin: 'Out'
        }
      ]
    })

    const result = await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/G',
      nodes: [{ id: 'sampler', type: 'PCGSurfaceSamplerSettings' }]
    })

    expect(textOf(result)).toContain('DefaultOutputNode')
    expect(textOf(result)).toContain('sampler → PCGSurfaceSampler_0')
  })

  /**
   * 图不存在会自动建，但**必须说出来**。不说的话路径写错会表现成
   * 「报告写成功了，可编辑器里那张图找不到」—— 最难查的一类现象。
   */
  it('自动建图时明确告知', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/PCG_New',
      created_graph: true,
      nodes: [],
      edges: [],
      graph_edges_after: []
    })

    const result = await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/PCG_New',
      nodes: [{ id: 'a', type: 'PCGSurfaceSamplerSettings' }]
    })

    expect(textOf(result)).toContain('已新建图')
  })

  it('图本来就在时不谎报新建', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      created_graph: false,
      nodes: [],
      edges: [],
      graph_edges_after: []
    })

    const result = await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/G',
      nodes: [{ id: 'a', type: 'PCGSurfaceSamplerSettings' }]
    })

    expect(textOf(result)).not.toContain('已新建图')
  })

  /**
   * merge 是默认，图里会留着这次没声明的旧节点。上一轮实测里正是这一点让人
   * 以为「写整图」= 重建，改完拓扑发现旧节点还在，多绕了三四轮删节点。
   * 所以残留必须被**主动指出来**，而不是等调用方自己比对两个列表。
   */
  it('merge 模式下主动点出图里的残留节点', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      mode: 'merge',
      cleared_nodes: 0,
      nodes: [
        { alias: 'sampler', node_id: 'PCGSurfaceSampler_2', type: 'PCGSurfaceSamplerSettings' }
      ],
      edges: [],
      graph_edges_after: [],
      graph_nodes_after: [
        { node_id: 'PCGSurfaceSampler_2', type: 'PCGSurfaceSamplerSettings' },
        { node_id: 'PCGSurfaceSampler_0', type: 'PCGSurfaceSamplerSettings' },
        { node_id: 'DefaultInputNode', type: 'PCGGraphInputOutputSettings' }
      ]
    })

    const result = await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/G',
      nodes: [{ id: 'sampler', type: 'PCGSurfaceSamplerSettings' }]
    })

    const text = textOf(result)
    expect(text).toContain('PCGSurfaceSampler_0')
    expect(text).toContain('replace')
    // Input/Output 端点永远在图里，不该被当成残留报出来
    expect(text).not.toContain('DefaultInputNode（')
  })

  it('replace 模式报出清掉了几个旧节点', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      mode: 'replace',
      cleared_nodes: 3,
      nodes: [{ alias: 'a', node_id: 'PCGSurfaceSampler_0', type: 'PCGSurfaceSamplerSettings' }],
      edges: [],
      graph_edges_after: [],
      graph_nodes_after: [{ node_id: 'PCGSurfaceSampler_0', type: 'PCGSurfaceSamplerSettings' }]
    })

    const result = await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/G',
      mode: 'replace',
      nodes: [{ id: 'a', type: 'PCGSurfaceSamplerSettings' }]
    })

    expect(lastCall().params.mode).toBe('replace')
    expect(textOf(result)).toContain('清掉了 3 个旧节点')
  })

  /**
   * 默认值只在引擎侧存在。两边各写一份必然漂移 —— 引脚名那次就是这么翻的车。
   */
  it('不填 mode 时不在这一层塞默认值', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      mode: 'replace',
      nodes: [],
      edges: [],
      graph_edges_after: []
    })

    await byName('pcg_apply_graph').execute('c', {
      graph_path: '/Game/PCG/G',
      nodes: [{ id: 'a', type: 'PCGSurfaceSamplerSettings' }]
    })

    expect(lastCall().params.mode).toBeUndefined()
  })

  it('整批失败时错误里带着逐条原因', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: '2 item(s) failed; the whole batch was rolled back. Nothing changed.',
      details: { failures: [{ item: 'spawner -> Output', error: 'pin types incompatible' }] },
      __rpc: { code: 400 }
    })

    await expect(
      byName('pcg_apply_graph').execute('c', {
        graph_path: '/Game/PCG/G',
        edges: [{ from: 'spawner', to: 'Output' }]
      })
    ).rejects.toThrow(/rolled back[\s\S]*pin types incompatible/)
  })
})

describe('pcg_spawn_volume', () => {
  /**
   * 只报请求的 size 会掩盖一类真问题：画刷有自己的枢轴，采样盒中心和 actor 位置
   * 可能差几十米，盒子没罩住地形时表现是「只采到几个点」而不是报错。
   * 实测里为此排查过一整轮。
   */
  it('报出采样盒的真实范围，而不只是请求值', async () => {
    callRequest.mockResolvedValue({
      actor_label: 'PCG_Forest',
      graph_assigned: true,
      graph_path: '/Game/PCG/G',
      actual_bounds: {
        center: { x: -12600, y: -12600, z: 4000 },
        extent: { x: 10000, y: 10000, z: 4000 },
        min: { x: -22600, y: -22600, z: 0 },
        max: { x: -2600, y: -2600, z: 8000 }
      }
    })

    const result = await byName('pcg_spawn_volume').execute('c', {
      graph_path: '/Game/PCG/G',
      location: { x: -12600, y: -12600, z: 0 }
    })

    const text = textOf(result)
    expect(text).toContain('-12600')
    expect(text).toContain('z 从 0 到 8000')
  })
})

describe('pcg_diagnose', () => {
  it('没问题时报出结论，而不是一个空列表', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      problems: [],
      node_count: 4,
      summary: 'The graph structure looks fine. Check that the PCG volume overlaps a landscape.'
    })

    const result = await byName('pcg_diagnose').execute('c', { graph_path: '/Game/PCG/G' })

    // 空列表对模型来说等价于「没查」，必须给一句明确结论加下一步方向
    expect(textOf(result)).toContain('volume overlaps a landscape')
  })

  /**
   * World Partition 是上一轮真正卡住任务的原因，而且光看图完全看不出来 ——
   * 图是健康的，只是采样器看不到没流送进来的地形。这条必须由工具说出来。
   */
  it('World Partition 关卡会被点名，并给出绕开办法', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      node_count: 4,
      world_partition: true,
      problems: [
        {
          severity: 'info',
          problem:
            'This level is a World Partition level. PCG samplers only see streamed-in actors.',
          fix: 'Load the region around the PCG volume, or test in a plain non-partitioned level.'
        }
      ]
    })

    const result = await byName('pcg_diagnose').execute('c', { graph_path: '/Game/PCG/G' })

    expect(textOf(result)).toContain('World Partition')
    expect(textOf(result)).toContain('non-partitioned')
  })

  it('每个问题都带着可执行的下一步', async () => {
    callRequest.mockResolvedValue({
      graph_path: '/Game/PCG/G',
      node_count: 3,
      problems: [
        {
          severity: 'blocker',
          problem: 'Nothing is connected to the graph Output node.',
          fix: "Connect your last node to Output. Its input pin is named 'Out' (not 'In')."
        }
      ]
    })

    const result = await byName('pcg_diagnose').execute('c', { graph_path: '/Game/PCG/G' })

    expect(textOf(result)).toContain('blocker')
    expect(textOf(result)).toContain('Output')
    expect(textOf(result)).toContain("named 'Out'")
  })
})

describe('参数按约定的字段名传给引擎', () => {
  it('pcg_add_node 原样透传 graph_path / node_type / properties', async () => {
    callRequest.mockResolvedValue({ node_id: 'PCGSurfaceSampler_0', type: 'X' })

    await byName('pcg_add_node').execute('call-1', {
      graph_path: '/Game/PCG/PCG_Forest',
      node_type: 'PCGSurfaceSamplerSettings',
      x: 100,
      y: -200,
      properties: { PointsPerSquaredMeter: 0.1 }
    })

    const { method, params } = lastCall()
    expect(method).toBe('pcg.add_node')
    expect(params).toMatchObject({
      graph_path: '/Game/PCG/PCG_Forest',
      node_type: 'PCGSurfaceSamplerSettings',
      x: 100,
      y: -200,
      properties: { PointsPerSquaredMeter: 0.1 }
    })
  })

  /**
   * 这一条挡的是一个真的发生过、代价很大的 bug。
   *
   * 之前这里默认 from_pin="Out" / to_pin="In"，看着无害，实际上：
   * 图的 Input 节点输出引脚叫 "In"、Output 节点输入引脚叫 "Out"，跟直觉正好相反。
   * 于是最常见的两条边（Input→X、X→Output）都连不上，而 UPCGGraph::AddEdge
   * 连不上也返回 To 节点，两个问题叠一起 = 每步都报成功、最后生成 0 个实例。
   */
  it('pcg_connect_pins 不填引脚名时不自己编默认值 —— 由引擎侧按实际引脚定', async () => {
    callRequest.mockResolvedValue({ from_node: 'a', to_node: 'b' })

    await byName('pcg_connect_pins').execute('call-2', {
      graph_path: '/Game/PCG/G',
      from_node: 'Input',
      to_node: 'Sampler'
    })

    const { params } = lastCall()
    // 两边各填一份默认值必然漂移，默认只在引擎侧存在
    expect(params.from_pin).toBeUndefined()
    expect(params.to_pin).toBeUndefined()
  })

  it('pcg_execute 用 actor_label 定位体积', async () => {
    callRequest.mockResolvedValue({
      actor_label: 'PCG_Forest',
      generated: true,
      elapsed_seconds: 3.2,
      component_count: 1,
      instance_count: 240,
      components: [{ component: 'ISM_0', mesh: 'SM_Tree', instances: 240 }]
    })

    await byName('pcg_execute').execute('call-3', { actor_label: 'PCG_Forest' })

    const { method, params } = lastCall()
    expect(method).toBe('pcg.execute')
    expect(params.actor_label).toBe('PCG_Forest')
  })
})

describe('pcg_execute 的结果要说人话', () => {
  const respond = (over: Record<string, unknown>): void => {
    callRequest.mockResolvedValue({
      actor_label: 'PCG_Forest',
      generated: true,
      elapsed_seconds: 3.2,
      component_count: 0,
      instance_count: 0,
      components: [],
      ...over
    })
  }

  it('生成成功时报出实例总数和用到的网格体', async () => {
    respond({
      component_count: 2,
      instance_count: 340,
      components: [
        { component: 'ISM_0', mesh: 'SM_Tree', instances: 300 },
        { component: 'ISM_1', mesh: 'SM_Rock', instances: 40 }
      ]
    })

    const result = await byName('pcg_execute').execute('c', { actor_label: 'PCG_Forest' })

    expect(textOf(result)).toContain('340')
    expect(textOf(result)).toContain('SM_Tree')
    expect(textOf(result)).toContain('SM_Rock')
  })

  /**
   * 「跑完了」和「跑出了东西」是两回事。引擎那边 generated=true 但
   * instance_count=0 是最常见的失败形态（图没连到 Output、生成器没指定网格体），
   * 这一层必须把它说成问题，而不是报一句「生成完成」了事。
   */
  it('跑完但零实例时明确说出来，并带上排查方向', async () => {
    respond({
      generated: true,
      instance_count: 0,
      note: 'The graph ran but produced no instances. Check that the graph is connected to the Output node.'
    })

    const result = await byName('pcg_execute').execute('c', { actor_label: 'PCG_Forest' })

    expect(textOf(result)).toContain('没有任何生成出来的实例')
    expect(textOf(result)).toContain('Output')
  })

  /**
   * 「跑完了但产出 0」时，图、连线、属性我们这边全能验证，唯独执行链路里
   * 发生了什么看不见。引擎自己每次执行都在往 LogPCG 写原因，抓回来交给模型，
   * 比让人事后去翻日志快一个数量级。
   */
  it('把引擎在生成期间写的 LogPCG 原样带回来', async () => {
    respond({
      generated: true,
      instance_count: 0,
      engine_log: [
        '[warning] LogPCG: Node StaticMeshSpawner: no mesh entries resolved',
        '[error] LogPCG: Graph execution aborted'
      ]
    })

    const result = await byName('pcg_execute').execute('c', { actor_label: 'PCG_Forest' })

    expect(textOf(result)).toContain('no mesh entries resolved')
    expect(textOf(result)).toContain('Graph execution aborted')
  })

  it('产出 0 且引擎什么都没说时，指路 verbose', async () => {
    respond({ generated: true, instance_count: 0 })

    const result = await byName('pcg_execute').execute('c', { actor_label: 'PCG_Forest' })

    expect(textOf(result)).toContain('verbose')
  })

  it('verbose 透传给引擎', async () => {
    respond({ generated: true, instance_count: 0 })

    await byName('pcg_execute').execute('c', { actor_label: 'PCG_Forest', verbose: true })

    expect(lastCall().params.verbose).toBe(true)
  })

  it('没等到完成确认时不谎称成功', async () => {
    respond({ generated: false, elapsed_seconds: 30, note: 'partitioned actors...' })

    const result = await byName('pcg_execute').execute('c', { actor_label: 'PCG_Forest' })

    expect(textOf(result)).toContain('没等到完成确认')
  })
})

describe('pcg_tidy_graph', () => {
  it('先读图、排完再写回坐标', async () => {
    callRequest
      .mockResolvedValueOnce({
        graph_path: '/Game/PCG/G',
        node_count: 2,
        edge_count: 1,
        nodes: [
          {
            node_id: 'In',
            type: 'PCGGraphInputOutputSettings',
            x: 0,
            y: 0,
            input_pins: [],
            output_pins: ['Out']
          },
          {
            node_id: 'S',
            type: 'PCGSurfaceSamplerSettings',
            x: 0,
            y: 0,
            input_pins: ['In'],
            output_pins: ['Out']
          }
        ],
        edges: [{ from_node: 'In', from_pin: 'Out', to_node: 'S', to_pin: 'In' }]
      })
      .mockResolvedValueOnce({ moved: 2, not_found: [] })

    const result = await byName('pcg_tidy_graph').execute('c', { graph_path: '/Game/PCG/G' })

    expect(callRequest.mock.calls[0][0]).toBe('pcg.get_graph')

    const [method, params] = callRequest.mock.calls[1] as [string, Record<string, unknown>]
    expect(method).toBe('pcg.set_node_positions')
    expect(params.graph_path).toBe('/Game/PCG/G')
    expect(params.positions).toHaveLength(2)
    expect(textOf(result)).toContain('已重排 2/2')
  })

  it('空图不去调写入接口', async () => {
    callRequest.mockResolvedValueOnce({
      graph_path: '/Game/PCG/G',
      node_count: 0,
      edge_count: 0,
      nodes: [],
      edges: []
    })

    const result = await byName('pcg_tidy_graph').execute('c', { graph_path: '/Game/PCG/G' })

    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(textOf(result)).toContain('不用排版')
  })

  it('引擎报有节点没排到时如实转述，不静默吞掉', async () => {
    callRequest
      .mockResolvedValueOnce({
        graph_path: '/Game/PCG/G',
        node_count: 2,
        edge_count: 0,
        nodes: [
          {
            node_id: 'In',
            type: 'PCGGraphInputOutputSettings',
            x: 0,
            y: 0,
            input_pins: [],
            output_pins: []
          },
          {
            node_id: 'S',
            type: 'PCGSurfaceSamplerSettings',
            x: 0,
            y: 0,
            input_pins: [],
            output_pins: []
          }
        ],
        edges: []
      })
      .mockResolvedValueOnce({ moved: 1, not_found: ['S'] })

    const result = await byName('pcg_tidy_graph').execute('c', { graph_path: '/Game/PCG/G' })

    expect(textOf(result)).toContain('S')
    expect(result.details).toMatchObject({ moved: 1, not_found: ['S'] })
  })
})

describe('RPC 失败要带着诊断信息抛出来', () => {
  it('PCG 没启用时的 501 说明会原样到模型手里', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'The PCG plugin (version 1.0) is installed but not enabled in this project.',
      __rpc: { code: 501 }
    })

    await expect(
      byName('pcg_add_node').execute('c', { graph_path: '/Game/PCG/G', node_type: 'X' })
    ).rejects.toThrow(/not enabled in this project/)
  })
})

/**
 * 图的用户参数。
 *
 * 这套工具之前**整个不存在** —— 用户说「这三个值我要能在细节面板里调」时，
 * 模型只能改道去建一个参数演员绕过去。
 * 所以这里测的重点是「别再留下让人去绕路的坑」：参数原样传到 RPC、
 * 没办成的那几条必须出现在模型读得到的正文里。
 */
describe('pcg_graph_parameters', () => {
  const RESPONSE = {
    graph_path: '/Game/PCG/Forest',
    parameters: [
      { name: 'Density', type: 'double', value: 1 },
      { name: 'Radius', type: 'double', value: 900 }
    ],
    parameter_count: 2,
    added: ['Density', 'Radius'],
    updated: [],
    removed: []
  }

  it('参数原样传到 pcg.graph_parameters', async () => {
    callRequest.mockResolvedValueOnce(RESPONSE)

    await byName('pcg_graph_parameters').execute('c', {
      graph_path: '/Game/PCG/Forest',
      parameters: [
        { name: 'Density', type: 'double', value: 1 },
        { name: 'Radius', type: 'double', value: 900 }
      ]
    })

    const { method, params } = lastCall()
    expect(method).toBe('pcg.graph_parameters')
    expect(params).toMatchObject({
      graph_path: '/Game/PCG/Forest',
      parameters: [
        { name: 'Density', type: 'double', value: 1 },
        { name: 'Radius', type: 'double', value: 900 }
      ]
    })
  })

  it('改完回读的完整清单进正文，含每个参数的类型和值', async () => {
    callRequest.mockResolvedValueOnce(RESPONSE)

    const result = await byName('pcg_graph_parameters').execute('c', {
      graph_path: '/Game/PCG/Forest',
      parameters: [{ name: 'Density', type: 'double', value: 1 }]
    })

    const text = textOf(result)
    expect(text).toContain('新建 2 个')
    expect(text).toContain('Density（double）= 1')
    expect(text).toContain('Radius（double）= 900')
  })

  it('一个参数都没有时直说，别回一份空清单让模型猜', async () => {
    callRequest.mockResolvedValueOnce({
      graph_path: '/Game/PCG/Forest',
      parameters: [],
      parameter_count: 0,
      added: [],
      updated: [],
      removed: []
    })

    const result = await byName('pcg_graph_parameters').execute('c', {
      graph_path: '/Game/PCG/Forest'
    })

    expect(textOf(result)).toContain('一个用户参数都没有')
  })

  /**
   * 「完整列表在 details 里」是死路 —— 模型上下文里只有 content 的文本。
   * 没办成的那几条要是只写进 details，模型会拿着一份看起来成功的回执继续往下走。
   */
  it('没办成的参数出现在正文里，不只在 details 里', async () => {
    callRequest.mockResolvedValueOnce({
      graph_path: '/Game/PCG/Forest',
      parameters: [{ name: 'Density', type: 'double', value: 1 }],
      parameter_count: 1,
      added: ['Density'],
      updated: [],
      removed: [],
      failed: [{ name: 'Radius', error: "already exists as 'float'" }]
    })

    const result = await byName('pcg_graph_parameters').execute('c', {
      graph_path: '/Game/PCG/Forest',
      parameters: [
        { name: 'Density', type: 'double', value: 1 },
        { name: 'Radius', type: 'double' }
      ]
    })

    const text = textOf(result)
    expect(text).toContain('没办成的')
    expect(text).toContain('Radius')
    expect(text).toContain('already exists')
  })

  it('老引擎上的 501 原样抛给模型，附替代方案', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error:
        'Graph user parameters need FInstancedPropertyBag, which lives in the StructUtils plugin ' +
        '(off by default) before UE 5.5 ... use PCGGetActorPropertySettings.',
      __rpc: { code: 501 }
    })

    await expect(
      byName('pcg_graph_parameters').execute('c', { graph_path: '/Game/PCG/Forest' })
    ).rejects.toThrow(/PCGGetActorPropertySettings/)
  })
})

/**
 * 顺序那一句。
 *
 * 2026-09-18 真机实测：先摆体积、后建参数的话，组件上那份副本停在
 * is_overridden=true 的旧值上，之后在图上怎么改都到不了它（20→20→20）。
 * 这句话只在**新建**参数时提示 —— 改值时提示纯属噪音。
 */
describe('pcg_graph_parameters 的顺序提醒', () => {
  const base = {
    graph_path: '/Game/PCG/Forest',
    parameters: [{ name: 'Density', type: 'double', value: 1 }],
    parameter_count: 1,
    added: [] as string[],
    updated: [] as string[],
    removed: [] as string[]
  }

  it('新建参数时提醒要先建参数再摆体积', async () => {
    callRequest.mockResolvedValueOnce({ ...base, added: ['Density'] })
    const result = await byName('pcg_graph_parameters').execute('c', {
      graph_path: '/Game/PCG/Forest',
      parameters: [{ name: 'Density', type: 'double', value: 1 }]
    })
    const text = textOf(result)
    expect(text).toContain('pcg_spawn_volume')
    expect(text).toContain('各自持有一份参数副本')
  })

  it('只改值时不提醒 —— 那时说顺序是噪音', async () => {
    callRequest.mockResolvedValueOnce({ ...base, updated: ['Density'] })
    const result = await byName('pcg_graph_parameters').execute('c', {
      graph_path: '/Game/PCG/Forest',
      parameters: [{ name: 'Density', value: 2 }]
    })
    expect(textOf(result)).not.toContain('pcg_spawn_volume')
  })
})
