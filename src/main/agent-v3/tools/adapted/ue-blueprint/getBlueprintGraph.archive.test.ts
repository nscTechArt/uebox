/**
 * 大图存档：200 个节点的蓝图图表走一遍真实的读图工具和它的存档声明。
 *
 * 钉三件事：目录页不超预算、目录里**确实没有**引脚（并且说了没有）、
 * 按 id 取回来的是带引脚的完整节点 —— 少一样，「读回来改一改写回去」就会在大图上坏掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { electronMock, targetContextMock } from '../../../testSupport/toolMocks'

const callRequest = vi.fn()

vi.mock('electron', () => electronMock())
vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount: () => 1 })
  }
}))
vi.mock('../../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import { ARCHIVE_BUDGET_CHARS, archiveResult, queryArchive } from '../../../core/resultArchive'
import { BLUEPRINT_GRAPH_ARCHIVE, createGetBlueprintGraphTool } from './getBlueprintGraph'

const guid = (i: number): string => `${String(i).padStart(8, '0')}-4C2B-4E8A-9F11-6D2B0A7C3E55`

/** 插件回的形状：连线只在每个引脚的 linked_to 里 */
function bigGraph(count: number): Record<string, unknown> {
  return {
    ok: true,
    blueprint_path: '/Game/UI/WBP_Inventory.WBP_Inventory',
    graph_name: 'EventGraph',
    nodes: Array.from({ length: count }, (_, i) => ({
      node_id: guid(i),
      class: 'K2Node_CallFunction',
      title: `打印字符串 ${i}`,
      write_as: 'CallFunction',
      member_name: 'PrintString',
      target_class: 'KismetSystemLibrary',
      pos_x: i * 300,
      pos_y: 0,
      pins: [
        {
          name: 'execute',
          dir: 'Input',
          category: 'exec',
          sub_category: '',
          is_array: false,
          is_reference: false,
          is_const: false
        },
        {
          name: 'then',
          dir: 'Output',
          category: 'exec',
          sub_category: '',
          is_array: false,
          is_reference: false,
          is_const: false,
          ...(i + 1 < count ? { linked_to: [{ node_id: guid(i + 1), pin_name: 'execute' }] } : {})
        },
        {
          name: 'InString',
          dir: 'Input',
          category: 'string',
          sub_category: '',
          is_array: false,
          is_reference: false,
          is_const: false,
          default_value: `第 ${i} 步`
        }
      ]
    }))
  }
}

async function readGraph(count: number): Promise<string> {
  callRequest.mockImplementation(async (command: string) =>
    command === 'blueprint.get_graph' ? bigGraph(count) : { ok: false }
  )
  const result = await (
    createGetBlueprintGraphTool() as unknown as {
      execute: (input: unknown) => Promise<Record<string, unknown>>
    }
  ).execute({ blueprint_path: '/Game/UI/WBP_Inventory', graph_name: 'EventGraph' })
  // 适配层给模型的就是这份 JSON（见 adaptV2Tool 的 toText）
  return JSON.stringify(result)
}

beforeEach(() => {
  callRequest.mockReset()
})

describe('blueprint_get_graph 的大图存档', () => {
  it('目录页不超预算、不带引脚，并明说没带', async () => {
    const text = await readGraph(200)
    expect(text.length).toBeGreaterThan(ARCHIVE_BUDGET_CHARS)

    const outcome = archiveResult(text, BLUEPRINT_GRAPH_ARCHIVE, 'r1')!
    expect(outcome.text.length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)

    const preview = JSON.parse(outcome.text) as {
      graph_name: string
      node_count: number
      nodes: Array<Record<string, unknown>>
      archived: { note: string; lists: Record<string, { total_rows: number }> }
    }
    // 表外字段原样：图名、节点数
    expect(preview.graph_name).toBe('EventGraph')
    expect(preview.node_count).toBe(200)
    expect(preview.archived.lists.nodes.total_rows).toBe(200)
    expect(preview.archived.lists.connections.total_rows).toBe(199)
    // 目录里有能写回去的那几样，没有引脚
    expect(preview.nodes[0]).toMatchObject({
      id: guid(0),
      class: 'K2Node_CallFunction',
      write_as: 'CallFunction',
      member_name: 'PrintString'
    })
    expect(preview.nodes.every((node) => !('pins' in node))).toBe(true)
    expect(preview.archived.note).toContain('result_query')
    expect(preview.archived.note).toContain('nodes / connections')
  })

  it('按 id 取回带引脚和默认值的完整节点，按节点查得到它的连线', async () => {
    const outcome = archiveResult(await readGraph(200), BLUEPRINT_GRAPH_ARCHIVE, 'r1')!

    const data = JSON.parse(outcome.record.text!) as Record<string, unknown>
    const nodes = queryArchive(outcome.record, data, { list: 'nodes', where: { id: [guid(150)] } })
    expect(nodes.matched).toBe(1)
    const [node] = nodes.rows as Array<{ pins: Array<{ name: string; default_value?: string }> }>
    expect(node.pins.map((pin) => pin.name)).toEqual(['execute', 'then', 'InString'])
    expect(node.pins[2].default_value).toBe('第 150 步')

    const wires = queryArchive(outcome.record, data, {
      list: 'connections',
      where: { from_node: guid(150) }
    })
    expect(wires.rows).toEqual([
      { from_node: guid(150), from_pin: 'then', to_node: guid(151), to_pin: 'execute' }
    ])
  })

  it('小图照旧整份给', async () => {
    expect(archiveResult(await readGraph(5), BLUEPRINT_GRAPH_ARCHIVE, 'r1')).toBeNull()
  })
})
