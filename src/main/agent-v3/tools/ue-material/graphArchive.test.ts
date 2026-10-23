/**
 * @vitest-environment node
 *
 * 材质大图存档：正文照旧（它自己按字符额度封顶），结尾补一句编号，
 * 额度外那些以前拿不到的节点和连线凭编号取回。
 *
 * 那段额度的来龙去脉见 `index.ts` 里 material_get_graph 的 toOutcome 注释：
 * 简表也列不完的节点，以前「这张图超出了一次能读完的规模」就是终点。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount: () => 1 })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import {
  ARCHIVE_BUDGET_CHARS,
  createResultArchiver,
  queryArchive,
  type ArchiveRecord
} from '../../core/resultArchive'
import type { ArchiveSpec } from '../defineTool'
import { materialTools } from './index'

type Tool = {
  name: string
  unrealBox: { archive?: ArchiveSpec }
  execute: (
    id: string,
    input: unknown
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>
}

const tool = (materialTools as unknown as Tool[]).find((t) => t.name === 'material_get_graph')!

/**
 * 800 个节点、每个挂一张 Megascans 风格的长路径贴图、带一段长注释，连线带两端类型 ——
 * 和 graphReadout.test.ts 里「最坏情况」同一种形状：详列、简表、连线三段额度全部撑满
 */
function bigMaterial(count: number): Record<string, unknown> {
  return {
    material_name: 'M_Terrain',
    material_path: '/Game/Materials/M_Terrain',
    // 三段额度之外的固定几行也要进夹具：主节点可用引脚、Substrate 提示、
    // 材质属性警告、插件附注 —— 少了它们，「正文加编号不超预算」这条就量不到最坏情况
    use_material_attributes: true,
    substrate_enabled: true,
    note: '插件附注：这张材质有 2 个函数调用节点的引脚来自函数资产，读图时按实例展开。',
    material_pins: [
      'BaseColor',
      'Metallic',
      'Specular',
      'Roughness',
      'Anisotropy',
      'EmissiveColor',
      'Opacity',
      'OpacityMask',
      'Normal',
      'Tangent',
      'WorldPositionOffset',
      'SubsurfaceColor',
      'CustomData0',
      'CustomData1',
      'AmbientOcclusion',
      'Refraction',
      'PixelDepthOffset',
      'ShadingModel',
      'FrontMaterial',
      'MaterialAttributes',
      'Displacement',
      'SurfaceThickness'
    ],
    node_count: count,
    nodes: Array.from({ length: count }, (_, i) => ({
      node_id: `TextureSample_${i}`,
      class: 'MaterialExpressionTextureSample',
      guid: `GUID-${i}`,
      value: `/Game/Megascans/Surfaces/Forest_Floor_${i}/T_Forest_Floor_${i}_4K_Albedo`,
      description: '湿度遮罩，别动。这一段是设计师随手写的说明，通常会写为什么要这么接。'.repeat(4),
      inputs: [{ name: 'Coordinates', is_connected: true, type: 'float2' }],
      outputs: [{ name: 'RGB', type: 'float3' }]
    })),
    connections: Array.from({ length: count - 1 }, (_, i) => ({
      from_node: `TextureSample_${i}`,
      from_pin: 'RGB',
      to_node: `TextureSample_${i + 1}`,
      to_input: 'Coordinates',
      from_type: 'float3',
      to_type: 'float2'
    }))
  }
}

beforeEach(() => {
  callRequest.mockReset()
})

describe('material_get_graph 的大图存档', () => {
  it('声明的是 details 来源：正文自己排版，表在 details 里', () => {
    expect(tool.unrealBox.archive?.source).toBe('details')
    expect(Object.keys(tool.unrealBox.archive?.lists ?? {})).toEqual(['nodes', 'connections'])
  })

  it('正文原样，结尾补编号；简表都没列到的节点凭编号取回引脚和值', async () => {
    callRequest.mockResolvedValue(bigMaterial(800))
    const result = await tool.execute('c1', { path: '/Game/Materials/M_Terrain' })
    const original = result.content[0].text!
    // 前提：这张图确实大到正文列不完
    expect(original).toContain('连简表都没列')

    const archive = createResultArchiver({
      getMessages: () => [],
      specFor: () => tool.unrealBox.archive,
      canQuery: () => true,
      loadQueryTool: () => undefined
    })
    const archived = archive({
      isError: false,
      toolCall: { name: 'material_get_graph' },
      result: { content: result.content, details: result.details }
    })!

    // 不存档时（外部 MCP、没有 result_query 的会话）拿的是大额度那一版，比预算大
    expect(original.length).toBeGreaterThan(ARCHIVE_BUDGET_CHARS)

    // 存档时换成小额度那一版，加上结尾的编号，落在存档预算以内
    const text = archived.content[0].text!
    expect(text.length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    expect(text).toContain('连简表都没列')
    const note = text.slice(text.lastIndexOf('\n\n'))
    expect(note).toContain('r1')
    expect(note).toContain('result_query')

    // 表就在 details 里，存档不再另存一份文本
    const record = archived.details.archive as ArchiveRecord
    expect(record).toEqual({ ref: 'r1', lists: ['nodes', 'connections'], source: 'details' })
    const data = archived.details
    const last = queryArchive(record, data, {
      list: 'nodes',
      where: { node_id: 'TextureSample_799' }
    })
    expect(last.rows).toEqual([
      expect.objectContaining({
        guid: 'GUID-799',
        value: '/Game/Megascans/Surfaces/Forest_Floor_799/T_Forest_Floor_799_4K_Albedo',
        inputs: [{ name: 'Coordinates', is_connected: true, type: 'float2' }]
      })
    ])
    const wire = queryArchive(record, data, {
      list: 'connections',
      where: { to_node: 'TextureSample_799' }
    })
    expect(wire.matched).toBe(1)
  })

  it('中等材质：完整数据超预算但正文放得下，正文原样给、只补编号', async () => {
    // 30 个节点：details 序列化后 17.7K、过了 16K，大额度正文 12.7K、完整且放得下
    callRequest.mockResolvedValue(bigMaterial(30))
    const result = await tool.execute('c1', { path: '/Game/Materials/M_Medium' })
    const original = result.content[0].text!
    expect(JSON.stringify(result.details).length).toBeGreaterThan(ARCHIVE_BUDGET_CHARS)
    expect(original).not.toContain('连简表都没列')

    const archived = createResultArchiver({
      getMessages: () => [],
      specFor: () => tool.unrealBox.archive,
      canQuery: () => true,
      loadQueryTool: () => undefined
    })({
      isError: false,
      toolCall: { name: 'material_get_graph' },
      result: { content: result.content, details: result.details }
    })!
    const text = archived.content[0].text!
    // 没换小额度：已经列出来的引脚不会被挤掉
    expect(text.startsWith(original)).toBe(true)
    expect(text.slice(original.length)).toContain('r1')
  })

  it('小材质不补编号', async () => {
    callRequest.mockResolvedValue(bigMaterial(3))
    const result = await tool.execute('c1', { path: '/Game/Materials/M_Small' })
    const archive = createResultArchiver({
      getMessages: () => [],
      specFor: () => tool.unrealBox.archive,
      canQuery: () => true,
      loadQueryTool: () => undefined
    })
    expect(
      archive({
        isError: false,
        toolCall: { name: 'material_get_graph' },
        result: { content: result.content, details: result.details }
      })
    ).toBeUndefined()
  })
})
