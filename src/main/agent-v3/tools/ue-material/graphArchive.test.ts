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

import { createResultArchiver, queryArchive, type ArchiveRecord } from '../../core/resultArchive'
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

/** 800 个节点、每个挂一张 Megascans 风格的长路径贴图 —— 详列和简表都列不完 */
function bigMaterial(count: number): Record<string, unknown> {
  return {
    material_name: 'M_Terrain',
    material_path: '/Game/Materials/M_Terrain',
    node_count: count,
    nodes: Array.from({ length: count }, (_, i) => ({
      node_id: `TextureSample_${i}`,
      class: 'MaterialExpressionTextureSample',
      guid: `GUID-${i}`,
      value: `/Game/Megascans/Surfaces/Forest_Floor_${i}/T_Forest_Floor_${i}_4K_Albedo`,
      inputs: [{ name: 'Coordinates', is_connected: true, type: 'float2' }],
      outputs: [{ name: 'RGB', type: 'float3' }]
    })),
    connections: Array.from({ length: count - 1 }, (_, i) => ({
      from_node: `TextureSample_${i}`,
      from_pin: 'RGB',
      to_node: `TextureSample_${i + 1}`,
      to_input: 'Coordinates'
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

    const text = archived.content[0].text!
    expect(text.startsWith(original)).toBe(true)
    expect(text.slice(original.length)).toContain('r1')
    expect(text.slice(original.length)).toContain('result_query')

    const record = archived.details.archive as ArchiveRecord
    expect(record.lists).toEqual(['nodes', 'connections'])
    const last = queryArchive(record, { list: 'nodes', where: { node_id: 'TextureSample_799' } })
    expect(last.rows).toEqual([
      expect.objectContaining({
        guid: 'GUID-799',
        value: '/Game/Megascans/Surfaces/Forest_Floor_799/T_Forest_Floor_799_4K_Albedo',
        inputs: [{ name: 'Coordinates', is_connected: true, type: 'float2' }]
      })
    ])
    const wire = queryArchive(record, {
      list: 'connections',
      where: { to_node: 'TextureSample_799' }
    })
    expect(wire.matched).toBe(1)
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
