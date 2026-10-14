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

import { createGetBlueprintGraphTool } from './getBlueprintGraph'

type ToolResult = Record<string, unknown>
const run = (input: unknown): Promise<ToolResult> =>
  (
    createGetBlueprintGraphTool() as unknown as {
      execute: (input: unknown) => Promise<ToolResult>
    }
  ).execute(input)

const notFound = (name: string): ToolResult => ({
  ok: false,
  error: `Graph not found: ${name}`,
  code: 404
})

const stateGraph = {
  ok: true,
  blueprint_path: '/Game/ABP_Hero.ABP_Hero',
  graph_name: 'AnimGraph/MR22基础动作/待机',
  graph_kind: 'state',
  nodes: []
}

beforeEach(() => {
  callRequest.mockReset()
})

/**
 * 真机上模型写的是 `blueprint_get_graph("待机")`，插件只认完整路径回了 404，
 * 模型据此断定「状态内部的图读不到」。
 */
describe('只写了状态名', () => {
  it('唯一对得上一张子图 → 换成完整路径再读一次', async () => {
    callRequest.mockImplementation(async (command: string, params: { graph_name?: string }) => {
      if (command === 'blueprint.list_graphs') {
        return {
          ok: true,
          graphs: [
            { name: 'AnimGraph', type: 'anim_graph' },
            { name: 'AnimGraph/MR22基础动作', type: 'state_machine' },
            { name: 'AnimGraph/MR22基础动作/待机', type: 'state' }
          ]
        }
      }
      return params.graph_name === 'AnimGraph/MR22基础动作/待机'
        ? stateGraph
        : notFound(String(params.graph_name))
    })

    const result = await run({ blueprint_path: '/Game/ABP_Hero', graph_name: '待机' })

    expect(result.success).toBe(true)
    expect(result.graph_name).toBe('AnimGraph/MR22基础动作/待机')
    expect(result.tried_graph_names).toEqual(['待机', 'AnimGraph/MR22基础动作/待机'])
  })

  it('旧插件看不到子图 → 报错里直说插件太旧，并给出更新插件的下一步', async () => {
    callRequest.mockImplementation(async (command: string, params: { graph_name?: string }) =>
      command === 'blueprint.list_graphs'
        ? {
            ok: true,
            graphs: [
              { name: 'EventGraph', type: 'event' },
              { name: 'AnimGraph', type: 'function' }
            ]
          }
        : notFound(String(params.graph_name))
    )

    const result = await run({ blueprint_path: '/Game/ABP_Hero', graph_name: '待机' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Graph not found: 待机')
    expect(String(result.error)).toContain('1.2.12')
    expect(String(result.error)).toContain('project_update_plugin')
  })

  it('蓝图本身找不到时不去查图列表', async () => {
    callRequest.mockResolvedValue({ ok: false, error: 'Blueprint not found: /Game/X', code: 404 })

    const result = await run({ blueprint_path: '/Game/X', graph_name: '待机' })

    expect(result.success).toBe(false)
    expect(callRequest.mock.calls.map(([command]) => command)).not.toContain(
      'blueprint.list_graphs'
    )
  })
})

/**
 * 真机上一张 UI 背包的 EventGraph 回了 707KB，传输层按 512KB 上限拒收，
 * agent 整个任务都没读到它（2026-10-13 反馈）。
 */
describe('大图分页', () => {
  const tooLarge = Object.assign(new Error('响应过大'), { code: 'E_MESSAGE_TOO_LARGE' })
  const page = (offset: number, count: number, total: number): ToolResult => ({
    ok: true,
    blueprint_path: '/Game/UI_Bag.UI_Bag',
    graph_name: 'EventGraph',
    nodes: Array.from({ length: count }, (_, i) => ({
      node_id: `n${offset + i}`,
      class: 'K2Node_CallFunction',
      title: 'Print',
      pos_x: 0,
      pos_y: 0,
      pins: []
    })),
    total_node_count: total,
    offset,
    ...(offset + count < total ? { next_offset: offset + count } : {})
  })

  it('整张超过上限 → 自动改成分页，并告诉模型从哪接着读', async () => {
    callRequest.mockImplementation(async (_command: string, params: { limit?: number }) => {
      if (!params.limit) throw tooLarge
      return page(0, params.limit, 400)
    })

    const result = await run({ blueprint_path: '/Game/UI_Bag', graph_name: 'EventGraph' })

    expect(result.success).toBe(true)
    expect(result.node_count).toBe(150)
    expect(result.total_node_count).toBe(400)
    expect(result.next_offset).toBe(150)
    expect(String(result.page_note)).toContain('offset=150')
  })

  it('一页还是太大 → 退到小页再试一次', async () => {
    callRequest.mockImplementation(async (_command: string, params: { limit?: number }) => {
      if (!params.limit || params.limit > 40) throw tooLarge
      return page(0, params.limit, 400)
    })

    const result = await run({ blueprint_path: '/Game/UI_Bag', graph_name: 'EventGraph' })

    expect(result.node_count).toBe(25)
  })

  it('分到小页仍然超限 → 只试两次就停，不让编辑器反复发整张大图', async () => {
    callRequest.mockRejectedValue(tooLarge)

    await run({ blueprint_path: '/Game/UI_Bag', graph_name: 'EventGraph' })

    expect(callRequest).toHaveBeenCalledTimes(3)
  })

  it('点名分页而插件不认（旧插件回整张）→ 说清楚这就是整张，别再翻页', async () => {
    callRequest.mockResolvedValue({
      ...page(0, 3, 3),
      total_node_count: undefined,
      offset: undefined
    })

    const result = await run({ blueprint_path: '/Game/UI_Bag', graph_name: 'EventGraph', limit: 2 })

    expect(String(result.page_note)).toContain('ignored offset/limit')
    expect(result).not.toHaveProperty('next_offset')
  })

  it('点名 offset 接着读 → 带上分页参数，最后一页说清楚读完了', async () => {
    callRequest.mockResolvedValue(page(300, 100, 400))

    const result = await run({
      blueprint_path: '/Game/UI_Bag',
      graph_name: 'EventGraph',
      offset: 300
    })

    expect(callRequest.mock.calls[0][1]).toMatchObject({ offset: 300, limit: 150 })
    expect(result.next_offset).toBeUndefined()
    expect(String(result.page_note)).toContain('last page')
  })

  it('分到最小一页仍然超限 → 报插件可能太旧，给更新插件的下一步', async () => {
    callRequest.mockRejectedValue(tooLarge)

    const result = await run({ blueprint_path: '/Game/UI_Bag', graph_name: 'EventGraph' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('project_update_plugin')
  })

  it('接着读的那页太大 → 退到小页，不直接报错', async () => {
    callRequest.mockImplementation(async (_command: string, params: { limit?: number }) => {
      if (!params.limit || params.limit > 40) throw tooLarge
      return page(25, params.limit, 400)
    })

    const result = await run({
      blueprint_path: '/Game/UI_Bag',
      graph_name: 'EventGraph',
      offset: 25
    })

    expect(result.node_count).toBe(25)
    expect(String(result.page_note)).toContain('offset=50, limit=25')
  })

  it('状态机那一页带了分页参数 → 不误报插件太旧', async () => {
    callRequest.mockResolvedValue({ ...stateGraph, graph_kind: 'state_machine', nodes: [] })

    const result = await run({
      blueprint_path: '/Game/ABP_Hero',
      graph_name: 'AnimGraph/SM',
      limit: 50
    })

    expect(result).not.toHaveProperty('page_note')
  })

  it('offset 越界 → 说清楚越界了，不报成空图的最后一页', async () => {
    callRequest.mockResolvedValue({ ...page(0, 0, 8), offset: 500 })

    const result = await run({
      blueprint_path: '/Game/UI_Bag',
      graph_name: 'EventGraph',
      offset: 500
    })

    expect(String(result.page_note)).toContain('past the end')
  })

  it('空图分页读 → 说是空图，不报越界', async () => {
    callRequest.mockResolvedValue(page(0, 0, 0))

    const result = await run({
      blueprint_path: '/Game/UI_Bag',
      graph_name: 'EventGraph',
      limit: 50
    })

    expect(String(result.page_note)).toContain('empty')
  })

  it('点名分页但旧插件回整张、小页也超限 → 给更新插件的下一步', async () => {
    callRequest.mockRejectedValue(tooLarge)

    const result = await run({
      blueprint_path: '/Game/UI_Bag',
      graph_name: 'EventGraph',
      limit: 100
    })

    expect(String(result.error)).toContain('project_update_plugin')
  })

  it('小图照旧整张读，不带分页字段', async () => {
    callRequest.mockResolvedValue({
      ...page(0, 3, 3),
      total_node_count: undefined,
      offset: undefined
    })

    const result = await run({ blueprint_path: '/Game/UI_Bag', graph_name: 'EventGraph' })

    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('limit')
    expect(result.node_count).toBe(3)
    expect(result).not.toHaveProperty('page_note')
  })
})
