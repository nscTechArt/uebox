/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { inspectTools } from './index'
import { formatInspectOutcome, type InspectOutput } from './inspectComponents'
import { formatLightCensus, type LightCensusOutput } from './lightCensus'
import { sliceGraph, type GraphData } from './materialGraphSlice'

const mockUe = vi.mocked(callUe)
const tool = (name: string): ReturnType<typeof inspectTools>[number] =>
  inspectTools().find((t) => t.name === name)!
const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => c.text ?? '').join('')

beforeEach(() => vi.resetAllMocks())

describe('细粒度只读工具', () => {
  // 只读子任务的工具清单按 risk 过滤 —— 这两个的全部意义就是让它不必再去要 Python
  it('都是只读工具', () => {
    expect(inspectTools().map((t) => [t.name, t.unrealBox.risk])).toEqual([
      ['ue_inspect_components', 'safe'],
      ['material_graph_slice', 'safe'],
      ['ue_light_census', 'safe']
    ])
  })
})

describe('ue_inspect_components', () => {
  it('targets 和 blueprint_path 必须二选一', async () => {
    await expect(tool('ue_inspect_components').execute('t', {})).rejects.toThrow()
    await expect(
      tool('ue_inspect_components').execute('t', {
        targets: { names: ['A'] },
        blueprint_path: '/Game/BP'
      })
    ).rejects.toThrow()
    expect(mockUe).not.toHaveBeenCalled()
  })

  /**
   * 反馈里那条：犬的新网格只接了动画，描边 / 覆层还留在旧组件上。
   * 两个组件的 Stencil 和覆层要分开报，而且每个槽实际在用的材质要看得见
   */
  it('每个组件分开报描边、覆层和实际材质', () => {
    const data: InspectOutput = {
      targets: [
        {
          kind: 'actor',
          name: 'Dog_01',
          class: '/Game/BP_Dog.BP_Dog_C',
          components: [
            {
              name: 'OldMesh',
              class: 'SkeletalMeshComponent',
              render: {
                visible: false,
                render_custom_depth: true,
                custom_depth_stencil: 1,
                overlay_material: '/Game/M_RimRed.M_RimRed',
                materials: [{ slot: 0, name: 'Body', material: '/Game/M_Old.M_Old' }]
              }
            },
            {
              name: 'NewMesh',
              class: 'SkeletalMeshComponent',
              render: {
                visible: true,
                render_custom_depth: false,
                custom_depth_stencil: 0,
                overlay_material: null,
                materials: [
                  {
                    slot: 7,
                    name: 'Cloth',
                    material: '/Game/MI_Dissolve.MI_Dissolve',
                    overridden: true
                  }
                ]
              },
              properties: { CustomDepthStencilValue: 0 },
              property_errors: { NoSuch: "unknown field 'NoSuch'" }
            }
          ]
        }
      ]
    }
    const out = formatInspectOutcome(data)
    expect(out).toContain('Custom Depth 开，Stencil=1')
    expect(out).toContain('覆层材质 /Game/M_RimRed.M_RimRed')
    expect(out).toContain('覆层材质 (无)')
    expect(out).toContain('槽 7 Cloth：/Game/MI_Dissolve.MI_Dissolve（组件上覆盖过）')
    expect(out).toContain('CustomDepthStencilValue = 0')
    expect(out).toContain('NoSuch：读不到')
  })

  it('没挑到组件时给出名单', () => {
    const out = formatInspectOutcome({
      targets: [
        {
          kind: 'blueprint_default',
          name: 'BP_Zombie',
          class: '/Game/BP_Zombie.BP_Zombie_C',
          components: [],
          available_components: ['Mesh', 'Capsule']
        }
      ],
      note: '蓝图读的是类默认值'
    })
    expect(out).toContain('这个对象上有：Mesh、Capsule')
    expect(out).toContain('蓝图读的是类默认值')
  })
})

describe('material_graph_slice', () => {
  // 主节点 ← N3(Multiply) ← N1(Texture) ；N3 ← N4(usage) ⇢ N5(declaration) ← N6
  const graph: GraphData = {
    material_name: 'M_Big',
    material_pins: ['BaseColor', 'OpacityMask'],
    nodes: [
      { node_id: 'N1', class: 'TextureSample', guid: 'G1', value: '/Game/T_Mask' },
      { node_id: 'N2', class: 'Constant', value: 1 },
      { node_id: 'N3', class: 'Multiply' },
      { node_id: 'N4', class: 'NamedRerouteUsage', reroute_declaration_node: 'N5' },
      { node_id: 'N5', class: 'NamedRerouteDeclaration' },
      { node_id: 'N6', class: 'Time' }
    ],
    connections: [
      { from_node: 'N3', to_node: 'Material', to_input: 'OpacityMask' },
      { from_node: 'N2', to_node: 'Material', to_input: 'BaseColor' },
      { from_node: 'N1', from_pin: 'R', to_node: 'N3', to_input: 'A' },
      { from_node: 'N4', to_node: 'N3', to_input: 'B' },
      { from_node: 'N6', to_node: 'N5', to_input: 'Input' }
    ]
  }

  it('从主节点引脚往上游走，不带无关分支', () => {
    const slice = sliceGraph(graph, { from: ['OpacityMask'], depth: 10 })
    expect(slice.nodes.map((n) => n.node_id).sort()).toEqual(['N1', 'N3', 'N4', 'N5', 'N6'])
    // BaseColor 那一支和这次查的无关
    expect(slice.nodes.some((n) => n.node_id === 'N2')).toBe(false)
    expect(slice.connections.some((c) => c.to_input === 'OpacityMask')).toBe(true)
  })

  // 走到 usage 就停等于没走 —— 复杂材质到处用命名重定向
  it('顺着命名重定向的 declaration 接着走', () => {
    const slice = sliceGraph(graph, { from: ['N4'], depth: 3 })
    expect(slice.nodes.map((n) => n.node_id).sort()).toEqual(['N4', 'N5', 'N6'])
  })

  it('到深度上限还有上游的节点列成边界', () => {
    const slice = sliceGraph(graph, { from: ['Material.OpacityMask'], depth: 1 })
    expect(slice.nodes.map((n) => n.node_id)).toEqual(['N3'])
    expect(slice.frontier).toEqual(['N3'])
  })

  it('guid 和 node_id 都认，对不上的起点报出来', () => {
    const slice = sliceGraph(graph, { nodeIds: ['g1', 'Nope'], depth: 3 })
    expect(slice.nodes.map((n) => n.node_id)).toEqual(['N1'])
    expect(slice.unknownStarts).toEqual(['Nope'])
  })

  it('工具复用 material.get_graph，只排版那一段', async () => {
    mockUe.mockResolvedValueOnce(graph)
    const result = await tool('material_graph_slice').execute('t', {
      path: '/Game/M_Big',
      from: ['OpacityMask'],
      depth: 1
    })
    expect(mockUe).toHaveBeenCalledWith(
      'material.get_graph',
      { path: '/Game/M_Big', include_values: true },
      expect.anything()
    )
    const out = text(result)
    expect(out).toContain('全图 6 个节点，这一段 1 个')
    expect(out).toContain('N3 的上游还没展开')
  })

  it('from 和 node_ids 都不给时拒绝，指向 material_get_graph', async () => {
    await expect(
      tool('material_graph_slice').execute('t', { path: '/Game/M_Big' })
    ).rejects.toThrow()
  })
})

describe('ue_light_census', () => {
  const lamp: LightCensusOutput['lights'][number] = {
    label: 'ParkLampLight_01',
    component: 'LightComponent0',
    type: 'point',
    mobility: 'movable',
    in_scene: true,
    cast_shadows: true,
    cast_dynamic_shadows: true,
    intensity: 5000,
    intensity_units: 'Candelas',
    attenuation_radius: 1500,
    max_draw_distance: 0,
    max_draw_distance_set: false,
    location: [100, 200, 300],
    census: {
      primitives: 42,
      movable: 3,
      stationary: 0,
      static: 39,
      wpo: 12,
      wpo_evaluation_off: 2,
      nanite: 30,
      non_nanite: 10,
      other: 2,
      instanced_components: 4,
      instances: 2300,
      top_meshes: [
        {
          mesh: '/Game/Foliage/SM_Grass.SM_Grass',
          primitives: 2,
          instances: 2000,
          movable: 0,
          wpo: 2,
          nanite: false
        }
      ]
    }
  }
  const base: LightCensusOutput = {
    world: 'editor',
    totals: {
      lights: 3,
      in_scene: 3,
      shadow_casting: 2,
      shadow_casting_local: 1,
      shadow_casting_local_without_max_draw_distance: 1,
      radius_census_done: 1,
      shadow_casting_primitives: 900,
      by_type: { point: 1, directional: 1, sky: 1 },
      by_mobility: { movable: 2, stationary: 1 }
    },
    lights: [
      lamp,
      {
        label: 'Sun',
        component: 'LightComponent0',
        type: 'directional',
        mobility: 'stationary',
        in_scene: true,
        cast_shadows: true,
        cast_dynamic_shadows: true,
        intensity: 10,
        max_draw_distance: 0,
        max_draw_distance_set: false
      }
    ]
  }

  // 「为什么卡」要落到每盏灯的半径里压着什么：可移动、WPO、Nanite、实例数都要看得见
  it('逐灯报设置和半径里的投影物体', () => {
    const out = formatLightCensus(base)
    expect(out).toContain('读的是编辑器世界')
    expect(out).toContain('共 3 盏灯')
    expect(out).toContain('点光源')
    expect(out).toContain('强度 5000 Candelas')
    expect(out).toContain('最大绘制距离未设')
    expect(out).toContain('半径内投影物体 42：可移动 3')
    expect(out).toContain('带 WPO 12（其中 2 个组件关了 Evaluate World Position Offset）')
    expect(out).toContain('Nanite 30 / 非 Nanite 10')
    expect(out).toContain('半径内 2,300 个实例')
    expect(out).toContain('/Game/Foliage/SM_Grass.SM_Grass（2,000 实例，非 Nanite，WPO 2）')
    expect(out).toContain('平行光的阴影不受半径约束')
  })

  // 只报事实：没有门槛，就不该出现「太多」「过多」这类判断
  it('不替用户判「灯太多」', () => {
    expect(formatLightCensus(base)).not.toMatch(/太多|过多|超标/)
  })

  it('说清读的是哪个世界：PIE 时带上插件的说明和实例数', () => {
    const out = formatLightCensus({
      ...base,
      world: 'pie',
      world_note: '含运行时生成的 Actor。',
      play_world_count: 2
    })
    expect(out).toContain('正在运行的游戏世界（PIE）')
    expect(out).toContain('含运行时生成的 Actor')
    expect(out).toContain('2 个游戏实例')
  })

  // 截断和着色器还在编译都会让数偏小 / 偏大，必须说出来，不能当成完整的数转述
  it('截断、预算用完、着色器在编译、聚光灯按整球都写明', () => {
    const out = formatLightCensus({
      ...base,
      lights: [{ ...lamp, type: 'spot', census: { ...lamp.census!, instances_upper_bound: true } }],
      lights_truncated: true,
      radius_census_skipped: 7,
      primitives_truncated: true,
      primitives_examined: 200000,
      instance_budget_exhausted: true,
      shaders_compiling: 120,
      limits: { radius_census_lights: 200 }
    })
    expect(out).toContain('只列了 1 盏明细')
    expect(out).toContain('还有 7 盏投影局部光没做半径普查（单次上限 200 盏）')
    expect(out).toContain('只拿前 200,000 个做半径判定')
    expect(out).toContain('是上界')
    expect(out).toContain('还有 120 个着色器在编译')
    expect(out).toContain('WPO 数现在是下限')
    expect(out).toContain('聚光灯按整个衰减半径球算')
  })

  it('没有灯时直说', () => {
    const out = formatLightCensus({
      ...base,
      totals: { ...base.totals, lights: 0, by_type: {}, by_mobility: {} },
      lights: []
    })
    expect(out).toContain('没有找到灯光组件')
  })

  it('参数原样传给 level.light_census，默认读当下的世界', async () => {
    mockUe.mockResolvedValueOnce(base)
    const result = await tool('ue_light_census').execute('t', { label_contains: 'Lamp' })
    expect(mockUe).toHaveBeenCalledWith(
      'level.light_census',
      { world: 'auto', limit: 30, label_contains: 'Lamp' },
      expect.anything()
    )
    expect(text(result)).toContain('ParkLampLight_01')
  })

  // 老插件回 404「Unknown method」，原文对谁都没意义 —— 翻成「插件太旧」并指向更新
  it('老插件没有这条命令时指向更新插件', async () => {
    mockUe.mockRejectedValueOnce(
      new Error('level.light_census 失败：Unknown method: level.light_census')
    )
    await expect(tool('ue_light_census').execute('t', {})).rejects.toThrow('project_update_plugin')
  })
})
