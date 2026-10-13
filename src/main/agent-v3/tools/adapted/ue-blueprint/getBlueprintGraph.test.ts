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
