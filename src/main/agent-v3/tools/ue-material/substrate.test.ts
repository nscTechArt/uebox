/**
 * @vitest-environment node
 *
 * Substrate 材质（UE 5.4+）在工具层要守住的几件事。
 *
 * Substrate 的坑都是「每一步都回成功、画面不对」那一类：FrontMaterial 接了之后
 * BaseColor 那一排静静失效；Slab 的 SubSurfaceType 没设上，玻璃就不透色；
 * 老插件不认 properties，设置被静默丢掉。所以这里钉的是**回执说的是引擎的状态**，
 * 以及那几句「不生效」的提示确实进了模型读得到的正文。
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

import { createMaterialApplyGraphTool } from './applyGraph'
import { materialTools } from './index'

type Executable = {
  name: string
  execute: (id: string, input: unknown) => Promise<{ content: { text?: string }[] }>
}

const byName = (name: string): Executable => {
  const found = (materialTools as unknown as Executable[]).find((t) => t.name === name)
  if (!found) throw new Error(`工具未注册：${name}`)
  return found
}

const textOf = (r: unknown): string =>
  (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('\n')

const callsTo = (method: string): Record<string, unknown>[] =>
  callRequest.mock.calls.filter((c) => c[0] === method).map((c) => c[1] as Record<string, unknown>)

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('material_apply_graph 写 Substrate 图', () => {
  const GLASS = {
    path: '/Game/M_Glass',
    nodes: [
      {
        id: 'slab',
        node_type: 'SubstrateSlabBSDF',
        properties: { SubSurfaceType: 'SimpleVolume' }
      },
      { id: 'cov', node_type: 'SubstrateWeight' }
    ],
    connections: [
      { from: 'slab.Out', to: 'cov.A' },
      { from: 'cov.Out', to: 'Material.FrontMaterial' }
    ]
  }

  it('Substrate 节点类型和 properties 原样发给引擎，FrontMaterial 照常连', async () => {
    let seq = 0
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: `Node_${seq++}` }
      if (method === 'material.compile') return { compiled: true, errors: [] }
      return {}
    })

    await createMaterialApplyGraphTool().execute('c1', { ...GLASS, tidy: false })

    const adds = callsTo('material.add_node')
    expect(adds[0]).toMatchObject({
      node_type: 'SubstrateSlabBSDF',
      properties: { SubSurfaceType: 'SimpleVolume' }
    })
    // 没给 properties 的节点不带这个字段，别让老插件看到一个空对象
    expect(adds[1]).not.toHaveProperty('properties')
    expect(callsTo('material.connect_pins').at(-1)).toMatchObject({
      target_node: 'Material',
      target_pin: 'FrontMaterial'
    })
  })

  it('回执里的节点设置是引擎回读的值，不是入参', async () => {
    let seq = 0
    callRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'material.add_node') {
        // 引擎把 "SimpleVolume" 规范成了自己的枚举名 —— 回执必须跟引擎走
        return params.properties
          ? { node_id: `Node_${seq++}`, properties: { SubSurfaceType: 'MSS_SimpleVolume' } }
          : { node_id: `Node_${seq++}` }
      }
      if (method === 'material.compile') return { compiled: true, errors: [] }
      return {}
    })

    const text = textOf(
      await createMaterialApplyGraphTool().execute('c1', { ...GLASS, tidy: false })
    )

    expect(text).toContain('SubSurfaceType=MSS_SimpleVolume')
    expect(text).not.toContain('SubSurfaceType=SimpleVolume')
  })

  it('老插件不认 properties（没有回读）时明说没设上', async () => {
    let seq = 0
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'material.add_node') return { node_id: `Node_${seq++}` }
      if (method === 'material.compile') return { compiled: true, errors: [] }
      return {}
    })

    const text = textOf(
      await createMaterialApplyGraphTool().execute('c1', { ...GLASS, tidy: false })
    )

    expect(text).toContain('没设上')
    expect(text).toContain('Node_0')
  })
})

describe('material_set_node_value 的 properties', () => {
  it('只给 properties 也行 —— Slab、算子这些节点根本没有「值」', async () => {
    callRequest.mockResolvedValue({ node_id: 'H_0', properties: { bUseParameterBlending: true } })

    await byName('material_set_node_value').execute('c1', {
      path: '/Game/M_Glass',
      node_id: 'H_0',
      properties: { bUseParameterBlending: true }
    })

    expect(callsTo('material.set_node_value')[0]).toMatchObject({
      material_path: '/Game/M_Glass',
      node_id: 'H_0',
      properties: { bUseParameterBlending: true }
    })
  })

  it('value 和 properties 都不给就挡住，一条命令都不发', async () => {
    await expect(
      byName('material_set_node_value').execute('c1', { path: '/Game/M_Glass', node_id: 'H_0' })
    ).rejects.toThrow()
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('material_set_property 的混合模式', () => {
  it('认 TranslucentColoredTransmittance（彩色玻璃）', async () => {
    callRequest.mockResolvedValue({
      material_path: '/Game/M_Glass',
      updated_properties: ['blend_mode'],
      failed_properties: []
    })

    await byName('material_set_property').execute('c1', {
      path: '/Game/M_Glass',
      properties: { blend_mode: 'TranslucentColoredTransmittance' }
    })

    expect(callsTo('material.set_property')[0]).toMatchObject({
      properties: { blend_mode: 'TranslucentColoredTransmittance' }
    })
  })
})

describe('material_get_graph 的 Substrate 提示', () => {
  const graph = {
    material_name: 'M_Old',
    substrate_enabled: true,
    nodes: [
      {
        node_id: 'Slab_0',
        class: 'MaterialExpressionSubstrateSlabBSDF',
        properties: { SubSurfaceType: 'MSS_SimpleVolume' },
        outputs: [{ name: 'Out', type: 'Substrate' }]
      }
    ],
    connections: [
      {
        from_node: 'C_1',
        from_pin: 'Out',
        to_node: 'Material',
        to_input: 'Metallic',
        ignored_by_substrate: true
      },
      { from_node: 'Slab_0', from_pin: 'Out', to_node: 'Material', to_input: 'FrontMaterial' }
    ],
    material_pins: ['WorldPositionOffset', 'FrontMaterial']
  }

  it('Substrate 下不生效的残线在正文里点破', async () => {
    callRequest.mockResolvedValue(graph)
    const text = textOf(await byName('material_get_graph').execute('c1', { path: '/Game/M_Old' }))

    const metallicLine = text.split('\n').find((l) => l.includes('Material.Metallic'))
    expect(metallicLine).toContain('Substrate 下不生效')
    const frontLine = text.split('\n').find((l) => l.includes('Material.FrontMaterial'))
    expect(frontLine).not.toContain('不生效')
  })

  it('改过的节点设置印在节点行里，开着 Substrate 时说清往哪接', async () => {
    callRequest.mockResolvedValue(graph)
    const text = textOf(await byName('material_get_graph').execute('c1', { path: '/Game/M_Old' }))

    expect(text.split('\n').find((l) => l.includes('Slab_0 '))).toContain(
      'SubSurfaceType=MSS_SimpleVolume'
    )
    expect(text).toContain('Material.FrontMaterial')
  })

  it('开着 Substrate 但 FrontMaterial 空着：说普通材质照常用 BaseColor 那一排，别把人往 Substrate 带', async () => {
    // 真机：用户要普通半透明塑料，AI 读完「开着 Substrate」就做成了 Substrate
    callRequest.mockResolvedValue({
      ...graph,
      nodes: [],
      connections: [],
      material_pins: ['BaseColor', 'Roughness', 'Opacity', 'FrontMaterial']
    })
    const text = textOf(await byName('material_get_graph').execute('c1', { path: '/Game/M_Plastic' }))

    expect(text).toContain('普通材质照常连 BaseColor')
    expect(text).not.toContain('按 Substrate 解释')
  })

  it('没开 Substrate 的项目不多嘴', async () => {
    callRequest.mockResolvedValue({ ...graph, substrate_enabled: false, connections: [] })
    const text = textOf(await byName('material_get_graph').execute('c1', { path: '/Game/M_Old' }))

    expect(text).not.toContain('开着 Substrate')
  })
})

describe('material_search_nodes 的 Substrate 信息', () => {
  it('节点设置和默认值印进正文', async () => {
    callRequest.mockResolvedValue({
      match_count: 1,
      total_types: 69,
      nodes: [
        {
          node_type: 'SubstrateHorizontalMixing',
          inputs: [{ name: 'Background', type: 'Substrate' }],
          outputs: [{ name: 'Out', type: 'Substrate' }],
          properties: { bUseParameterBlending: false }
        }
      ]
    })
    const text = textOf(await byName('material_search_nodes').execute('c1', { query: 'Substrate' }))

    expect(text).toContain('bUseParameterBlending（false）')
  })

  it('项目用不了 Substrate 时，原因放在第一行', async () => {
    callRequest.mockResolvedValue({
      match_count: 1,
      total_types: 69,
      substrate_enabled: false,
      substrate_note:
        'Substrate is not enabled in this project ... r.Substrate=True ... restart the editor',
      nodes: [{ node_type: 'SubstrateSlabBSDF', inputs: [], outputs: [] }]
    })
    const text = textOf(await byName('material_search_nodes').execute('c1', { query: 'Substrate' }))

    expect(text.split('\n')[0]).toContain('r.Substrate=True')
  })
})
