/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../defineUeTool', () => ({
  callUe: vi.fn()
}))

import { callUe } from '../defineUeTool'
import { inspectTools } from './index'
import { formatInspectOutcome, type InspectOutput } from './inspectComponents'
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
      ['material_graph_slice', 'safe']
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
