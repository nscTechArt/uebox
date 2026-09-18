/**
 * @vitest-environment node
 *
 * `blueprint_search_nodes` 的契约测试。
 *
 * 这个工具存在的唯一理由是让「查一批 → 写一整张」成立，所以测的重点是
 * **返回能不能直接拿去写图**：member_name 要能原样填进 apply_graph，
 * 引脚签名要在，一条都没搜到时要说清楚下一步怎么办。
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

import { createSearchBlueprintNodesTool } from './searchBlueprintNodes'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createSearchBlueprintNodesTool() as unknown as Executable).execute(input)

const printStringHit = {
  ok: true,
  query: 'print',
  match_count: 1,
  total_candidates: 1,
  functions: [
    {
      name: 'PrintString',
      member_name: 'KismetSystemLibrary.PrintString',
      class: 'KismetSystemLibrary',
      is_pure: false,
      summary: 'Prints a string to the log and optionally the screen',
      params: [
        { name: 'InString', type: 'FString', dir: 'Input' },
        { name: 'bPrintToScreen', type: 'bool', dir: 'Input' }
      ]
    }
  ]
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('查函数', () => {
  it('把 query / blueprint_path / limit 发给插件', async () => {
    callRequest.mockResolvedValue(printStringHit)

    await run({ query: 'print', blueprint_path: '/Game/BP_Door', limit: 20 })

    const [command, params] = callRequest.mock.calls[0]
    expect(command).toBe('blueprint.search_nodes')
    expect(params).toEqual({ query: 'print', blueprint_path: '/Game/BP_Door', limit: 20 })
  })

  it('可选参数没给就不发 —— 别把 undefined 传下去', async () => {
    callRequest.mockResolvedValue(printStringHit)

    await run({ query: 'print' })

    expect(callRequest.mock.calls[0][1]).toEqual({ query: 'print' })
  })

  /**
   * 这条是这个工具的全部价值：不建节点就能拿到引脚名。
   * 引脚签名要是丢了，调用方还是只能靠「先建一个看一眼」。
   */
  it('引脚签名原样回给调用方', async () => {
    callRequest.mockResolvedValue(printStringHit)

    const result = await run({ query: 'print' })

    const functions = result.functions as typeof printStringHit.functions
    expect(functions[0].member_name).toBe('KismetSystemLibrary.PrintString')
    expect(functions[0].params.map((p) => p.name)).toEqual(['InString', 'bPrintToScreen'])
  })

  it('截断提示原样带上 —— 不能让调用方把前 N 个当成全部', async () => {
    callRequest.mockResolvedValue({
      ...printStringHit,
      match_count: 12,
      total_candidates: 87,
      note: 'Showing 12 of 87 matches - narrow the query or raise limit.'
    })

    const result = await run({ query: 'get' })

    expect(result.note).toContain('87')
  })
})

describe('一条都没搜到', () => {
  /**
   * 「没找到」这三个字不够用 —— 模型多半会用同一个词再搜一遍。
   * 得说清楚这是子串匹配、以及带上 blueprint_path 能扩大范围。
   */
  it('给出下一步怎么办，而不是只说没找到', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      query: '让门自己开',
      match_count: 0,
      total_candidates: 0,
      functions: []
    })

    const result = await run({ query: '让门自己开' })

    expect(result.success).toBe(true)
    expect(result.match_count).toBe(0)
    expect(String(result.summary)).toContain('自然语言')
    expect(String(result.summary)).toContain('blueprint_path')
  })

  /**
   * 搜索范围是「函数库 + 这个蓝图的父类链」，别的类身上的成员函数一条都照不到
   * （插件 `UAL_ForEachFunctionSource`）。而 apply_graph 按类名解析，范围比这里宽得多 ——
   * TextBlock.SetText 搜不到却能用。
   *
   * 2026-09-16 的反馈：模型搜 SetText 只搜出 KismetSystemLibrary.SetTextPropertyByName，
   * 按「不要猜函数名」的规矩选了它 —— 那个节点走反射直写字段，屏幕永远不重画。
   * 「搜不到 ≠ 不存在」必须在零命中的时候当场说，不能等它自己悟。
   */
  it('零命中时说清搜不到不等于不存在，并给出直接写类名的走法', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      query: 'TextBlock',
      match_count: 0,
      total_candidates: 0,
      functions: []
    })

    const result = await run({ query: 'TextBlock' })

    expect(String(result.summary)).toContain('不代表函数不存在')
    expect(String(result.summary)).toContain('TextBlock.SetText')
    // 别退而求其次用反射节点
    expect(String(result.summary)).toContain('SetXxxPropertyByName')
  })
})

describe('连不上引擎', () => {
  it('没有连接时直说，不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await run({ query: 'print' })

    expect(result.success).toBe(false)
    // 断言落在「说清没连上 + 给出下一步」上，不落在具体措辞上：
    // 这句话的来源是共用常量 UE_NOT_CONNECTED_MESSAGE（`tools/defineUeTool.ts`）
    expect(String(result.error)).toContain('引擎未连接')
    expect(String(result.error)).toContain('ue_session_health')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('ok=false 时算失败', async () => {
    callRequest.mockResolvedValue({ ok: false, error: 'boom' })

    const result = await run({ query: 'print' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('boom')
  })
})
