/**
 * @vitest-environment node
 *
 * `blueprint_library_save` 的三条性质：
 *
 *   1. 存不下去的片段**当场拒绝并列全原因**，不留一个到期才爆的承诺；
 *   2. 存进去的正文是 `export_t3d` 的原文，**盒子一个字都不改**；
 *   3. 每条真的落盘之后**广播一次**，界面据此刷新。
 *
 * 第 3 条尤其容易被摘掉而没人发现：界面那边曾经写成
 * `await appExecuteAgent(); reload()` —— 而那个函数是后台发起、立刻返回的，
 * await 完的时候条目根本还没存。所以刷新的触发点必须钉在「落盘之后」。
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

vi.mock('./vaultRoot', () => ({
  requireVaultRoot: () => ({ vaultRoot: 'H:/fake-vault' }),
  getVaultRoot: () => 'H:/fake-vault'
}))

const { sendToAppWindows } = vi.hoisted(() => ({ sendToAppWindows: vi.fn() }))
vi.mock('../../../../appWindows', () => ({ sendToAppWindows }))

const { saveSnippetEntry } = vi.hoisted(() => ({ saveSnippetEntry: vi.fn() }))
vi.mock('../../../../services/library/libraryEntryStore', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../services/library/libraryEntryStore')
  >('../../../../services/library/libraryEntryStore')
  return { ...actual, saveSnippetEntry }
})

vi.mock('../ue-blueprint/resolveBlueprintPath', () => ({
  resolveBlueprintPathInput: async (input: string) => ({
    blueprintPath: input,
    source: 'explicit',
    wasPlaceholder: false
  })
}))

import { createBlueprintLibrarySaveTool } from './saveBlueprintSnippet'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createBlueprintLibrarySaveTool() as unknown as Executable).execute(input)

const INPUT = {
  blueprint_path: '/Game/BP_Probe',
  graph_name: 'EventGraph',
  entry_name: '受击闪红'
}

/** 一张能存下去的图：BeginPlay → PrintString，都是引擎内置的 */
function cleanGraph(): unknown {
  return {
    blueprint_path: '/Game/BP_Probe',
    graph_name: 'EventGraph',
    nodes: [
      {
        node_id: 'begin',
        class: 'K2Node_Event',
        title: '事件开始运行',
        write_as: 'Event',
        member_name: 'ReceiveBeginPlay',
        pins: [
          {
            name: 'then',
            dir: 'Output',
            category: 'exec',
            linked_to: [{ node_id: 'print', pin_name: 'execute' }]
          }
        ]
      },
      {
        node_id: 'print',
        class: 'K2Node_CallFunction',
        write_as: 'Function',
        member_name: 'KismetSystemLibrary.PrintString',
        pins: [
          { name: 'execute', dir: 'Input', category: 'exec' },
          { name: 'InString', dir: 'Input', category: 'string', default_value: 'hi' }
        ]
      }
    ]
  }
}

const T3D =
  'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="K2Node_Event_0"\nEnd Object'

/** `blueprint.export_t3d` 的正常回执 */
function exported(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    graph_name: 'EventGraph',
    node_count: 2,
    text: T3D,
    text_length: T3D.length,
    truncated: false,
    ...overrides
  }
}

let exportResponse: unknown

beforeEach(() => {
  vi.clearAllMocks()
  getConnectionCount.mockReturnValue(1)
  saveSnippetEntry.mockResolvedValue({ dirPath: 'x', relPath: 'x', library: 'blueprint' })
  exportResponse = exported()
  callRequest.mockImplementation(async (method: string) => {
    if (method === 'blueprint.get_graph') return cleanGraph()
    if (method === 'blueprint.export_t3d') return exportResponse
    return null
  })
})

describe('存下去之后广播', () => {
  it('落盘成功 → 发一条 library:entry-saved', async () => {
    const result = await run(INPUT)

    expect(result.success).toBe(true)
    expect(sendToAppWindows).toHaveBeenCalledWith('library:entry-saved', {
      library: 'blueprint',
      entryId: result.entry_id
    })
  })

  it('落盘失败 → 不广播（列表没必要刷，也不该以为存上了）', async () => {
    saveSnippetEntry.mockResolvedValue(null)

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(sendToAppWindows).not.toHaveBeenCalled()
  })

  it('片段被拒 → 不广播', async () => {
    // 引用了变量，按决定 6 当场拒绝
    callRequest.mockImplementation(async () => ({
      blueprint_path: '/Game/BP_Probe',
      graph_name: 'EventGraph',
      nodes: [
        {
          node_id: 'v',
          class: 'K2Node_VariableGet',
          title: 'Health',
          write_as: 'VariableGet',
          member_name: 'Health',
          pins: []
        }
      ]
    }))

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Health')
    expect(sendToAppWindows).not.toHaveBeenCalled()
  })
})

describe('没连引擎', () => {
  it('给人话，而且不去写保管库', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('虚幻编辑器')
    expect(saveSnippetEntry).not.toHaveBeenCalled()
  })
})

describe('连线从 linked_to 摊出来', () => {
  it('插件不发顶层 connections，摊平之后片段里要有那根线', async () => {
    const result = await run(INPUT)

    expect(result.success).toBe(true)
    expect(result.connection_count).toBe(1)
    expect(result.node_count).toBe(2)
  })
})

describe('存的是 export_t3d 的原文', () => {
  it('正文原样落库，盒子不加工', async () => {
    await run(INPUT)

    expect(saveSnippetEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        t3d: T3D,
        meta: expect.objectContaining({ nodeCount: 2, connectionCount: 1 })
      })
    )
  })

  it('圈了选区就把 node_ids 带给 export_t3d —— 不带就是整张图', async () => {
    await run({ ...INPUT, node_ids: ['print'] })

    expect(callRequest).toHaveBeenCalledWith(
      'blueprint.export_t3d',
      expect.objectContaining({ node_ids: ['print'] }),
      'conn-1',
      expect.any(Number)
    )
  })

  it('不圈选区就不发 node_ids 字段', async () => {
    await run(INPUT)

    const call = callRequest.mock.calls.find(([method]) => method === 'blueprint.export_t3d')
    expect(call?.[1]).not.toHaveProperty('node_ids')
  })
})

describe('export_t3d 出问题时不许落库', () => {
  it('文本被截断 → 拒绝。截断过的 T3D 粘不回去，存下来就是个打不开的条目', async () => {
    exportResponse = exported({ truncated: true, text_length: 999999 })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('截断')
    expect(saveSnippetEntry).not.toHaveBeenCalled()
  })

  it('点名的节点少了几个 → 拒绝，让调用方重读一次图', async () => {
    /*
     * 一半在、一半不在：依赖扫描看到 print 还在，放行；export_t3d 那头才
     * 报出 ghost-id 找不到。这时候**不能**把剩下那半存进去 ——
     * 用户圈了三个节点，存下来只有两个，他不会发现。
     */
    exportResponse = exported({ ok: false, not_found: ['ghost-id'] })

    const result = await run({ ...INPUT, node_ids: ['print', 'ghost-id'] })
    expect(result.success).toBe(false)
    expect(result.not_found).toEqual(['ghost-id'])
    expect(saveSnippetEntry).not.toHaveBeenCalled()
  })

  it('点名的节点一个都不在图里 → 依赖扫描先拦下，不用等到 export', async () => {
    const result = await run({ ...INPUT, node_ids: ['ghost-id'] })
    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalledWith(
      'blueprint.export_t3d',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('插件没给正文 → 拒绝，不存一个空条目', async () => {
    exportResponse = { ok: false, error: 'Nothing to export' }

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Nothing to export')
    expect(saveSnippetEntry).not.toHaveBeenCalled()
  })

  it('插件不响应 → 拒绝', async () => {
    exportResponse = null

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('export_t3d')
    expect(saveSnippetEntry).not.toHaveBeenCalled()
  })
})
