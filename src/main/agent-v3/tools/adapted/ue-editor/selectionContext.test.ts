/**
 * @vitest-environment node
 *
 * `ue_get_selection` 的契约测试。
 *
 * 重点在几条**说错了不会报错、只会让模型改错东西**的性质：
 *   - node_id 必须原样透传（它要被直接喂回 ue_bp_* / ue_material_* 改）
 *   - 什么都没选中要明说，不能沉默 —— 模型会把空当成「随便挑一个」
 *   - 截断了要让模型知道自己看到的不是全部
 *   - 只读工具不许把 UE 窗口调到前面来
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { createGetSelectionTool, summarizeSelection } from './selectionContext'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const getSelection = (): Promise<ToolResult> =>
  (createGetSelectionTool() as unknown as Executable).execute({})

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_get_selection', () => {
  it('把选中节点的 node_id 原样带上来', async () => {
    callRequest.mockResolvedValue({
      focusedEditor: { type: 'blueprint', name: 'BP_Door', path: '/Game/BP_Door.BP_Door' },
      focusedGraph: { name: 'EventGraph', path: '/Game/BP_Door.BP_Door:EventGraph', node_count: 7 },
      selectedNodes: [
        {
          node_id: 'A1B2C3D4-0000-0000-0000-000000000001',
          class: 'K2Node_CallFunction',
          title: 'Set Actor Location',
          pos_x: 320,
          pos_y: -80
        }
      ],
      selectedNodeCount: 1,
      selectedNodesTruncated: false
    })

    const result = await getSelection()

    expect(result.success).toBe(true)
    // 改错一个字，模型拿到的 id 就喂不回去了
    expect((result.selectedNodes as Array<{ node_id: string }>)[0].node_id).toBe(
      'A1B2C3D4-0000-0000-0000-000000000001'
    )
    expect(result.summary).toContain('Set Actor Location')
    expect(result.summary).toContain('EventGraph')
  })

  it('查焦点时不许把 UE 窗口调到前面来', async () => {
    callRequest.mockResolvedValue({ hasOpenEditors: false })

    await getSelection()

    // 参数必须是空的：任何「顺便聚焦」的开关都会让一个只读工具动用户的窗口
    expect(callRequest).toHaveBeenCalledWith('editor.get_focus_context', {}, 'conn-1', 10_000)
  })

  it('什么都没选中时明说，不给模型留想象空间', async () => {
    callRequest.mockResolvedValue({
      focusedEditor: { type: 'level', name: 'Main', path: '/Game/Maps/Main' },
      hasOpenEditors: false
    })

    const result = await getSelection()

    expect(result.success).toBe(true)
    expect(result.summary).toContain('没有选中任何东西')
  })

  it('插件没响应算失败，不算「什么都没选」', async () => {
    callRequest.mockResolvedValue(null)

    const result = await getSelection()

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('editor.get_focus_context')
  })

  it('没连引擎时给的是能照做的话，不是堆栈', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await getSelection()

    expect(result.success).toBe(false)
    // 断言落在「说清没连上 + 给出下一步」上，不落在具体措辞上：
    // 这句话的来源是共用常量 UE_NOT_CONNECTED_MESSAGE（`tools/defineUeTool.ts`）
    expect(String(result.error)).toContain('引擎未连接')
    expect(String(result.error)).toContain('ue_session_health')
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('summarizeSelection', () => {
  it('Actor 用大纲里显示的名字，不用内部名', async () => {
    const summary = summarizeSelection({
      focusedEditor: { type: 'level', name: 'Main', path: '/Game/Maps/Main' },
      selectedActors: [
        { name: 'StaticMeshActor_12', label: '大门', class: 'StaticMeshActor', path: '/Game/x' }
      ],
      selectedActorCount: 1
    })

    // 用户嘴里说的是「大门」，不是 StaticMeshActor_12
    expect(summary).toContain('大门')
    expect(summary).not.toContain('StaticMeshActor_12')
  })

  it('截断时报的是总数，不是这次拿到的条数', () => {
    const summary = summarizeSelection({
      selectedActors: [
        { name: 'A', label: 'A', class: 'Actor', path: '/Game/a' },
        { name: 'B', label: 'B', class: 'Actor', path: '/Game/b' }
      ],
      selectedActorCount: 300,
      selectedActorsTruncated: true
    })

    // 报 2 会让模型以为用户只选了两个，然后漏掉 298 个
    expect(summary).toContain('300')
  })

  it('编辑器里什么都没开也要给一句话，不能是空串', () => {
    expect(summarizeSelection({})).toContain('没有打开任何资产')
  })
})
