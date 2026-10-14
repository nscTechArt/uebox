/**
 * @vitest-environment node
 *
 * `blueprint_find_usages` 的契约：参数怎么到插件、摘要怎么说、覆盖不全时那一行一定在。
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

import {
  buildFindUsagesParams,
  createFindBlueprintUsagesTool,
  describeIncompleteness,
  FindBlueprintUsagesSchema,
  summarizeFindUsages,
  type FindInBlueprintsResponse
} from './findBlueprintUsages'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createFindBlueprintUsagesTool() as unknown as Executable).execute(input)

function response(overrides: Partial<FindInBlueprintsResponse> = {}): FindInBlueprintsResponse {
  return {
    ok: true,
    query: 'ApplyDamage',
    blueprint_count: 2,
    match_count: 3,
    blueprints: [
      {
        path: '/Game/AI/BP_Enemy',
        object_path: '/Game/AI/BP_Enemy.BP_Enemy',
        match_count: 2,
        matches: [
          { text: 'Apply Damage', category: 'Function Call', context: 'EventGraph' },
          { text: 'Apply Damage', category: 'Function Call', context: 'TakeHit' }
        ]
      },
      {
        path: '/Game/Traps/BP_Spikes',
        match_count: 1,
        matches: [{ text: 'Apply Damage', context: 'EventGraph' }]
      }
    ],
    timed_out: false,
    coverage: {
      unindexed: 0,
      out_of_date: 0,
      failed_to_index: 0,
      indexing_in_progress: false,
      asset_discovery_in_progress: false,
      complete: true
    },
    ...overrides
  }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('参数', () => {
  it('只发给了的字段，query 去掉首尾空白', () => {
    const input = FindBlueprintUsagesSchema.parse({ query: '  Health ' })
    expect(buildFindUsagesParams(input)).toEqual({ query: 'Health' })
  })

  it('limit 和 index_unindexed 原样到插件；index_unindexed=false 不发', () => {
    expect(
      buildFindUsagesParams(
        FindBlueprintUsagesSchema.parse({ query: 'Health', limit: 20, index_unindexed: true })
      )
    ).toEqual({ query: 'Health', limit: 20, index_unindexed: true })
    expect(
      buildFindUsagesParams(
        FindBlueprintUsagesSchema.parse({ query: 'Health', index_unindexed: false })
      )
    ).toEqual({ query: 'Health' })
  })

  it('空 query 和越界的 limit 在 schema 就被拦下', () => {
    expect(FindBlueprintUsagesSchema.safeParse({ query: '' }).success).toBe(false)
    expect(FindBlueprintUsagesSchema.safeParse({ query: 'a', limit: 0 }).success).toBe(false)
    expect(FindBlueprintUsagesSchema.safeParse({ query: 'a', limit: 501 }).success).toBe(false)
  })

  it('走 blueprint.find_in_blueprints，带目标连接和加长的超时', async () => {
    callRequest.mockResolvedValue(response())
    await run({ query: 'ApplyDamage', limit: 5 })
    expect(callRequest).toHaveBeenCalledWith(
      'blueprint.find_in_blueprints',
      { query: 'ApplyDamage', limit: 5 },
      'conn-1',
      expect.any(Number)
    )
    expect(callRequest.mock.calls[0][3]).toBeGreaterThan(60_000)
  })
})

describe('摘要', () => {
  it('全覆盖：列蓝图和命中位置，没有「不全」那行', () => {
    const text = summarizeFindUsages(response())
    expect(text.split('\n')[0]).toBe('2 个蓝图匹配「ApplyDamage」（共 3 处）')
    expect(text).toContain('/Game/AI/BP_Enemy（2 处）：EventGraph > Apply Damage')
    expect(text).toContain('/Game/Traps/BP_Spikes（1 处）')
    expect(text).not.toContain('结果可能不全')
  })

  it('有未索引的蓝图时单列一行，说清没被搜和怎么补', () => {
    const text = summarizeFindUsages(
      response({
        coverage: {
          unindexed: 37,
          out_of_date: 4,
          failed_to_index: 0,
          indexing_in_progress: false,
          asset_discovery_in_progress: false,
          complete: false
        }
      })
    )
    const line = text.split('\n').find((l) => l.startsWith('结果可能不全'))
    expect(line).toBeDefined()
    expect(line).toContain('37 个蓝图没有索引、根本没被搜')
    expect(line).toContain('4 个索引格式过旧')
    expect(line).toContain('index_unindexed: true')
  })

  it('0 命中但不全：不能只说「没有蓝图匹配」', () => {
    const text = summarizeFindUsages(
      response({
        blueprint_count: 0,
        match_count: 0,
        blueprints: [],
        coverage: {
          unindexed: 3,
          out_of_date: 0,
          failed_to_index: 0,
          indexing_in_progress: false,
          asset_discovery_in_progress: false,
          complete: false
        }
      })
    )
    expect(text).toContain('没有蓝图匹配「ApplyDamage」')
    expect(text).toContain('结果可能不全：3 个蓝图没有索引')
  })

  it('0 命中且全覆盖：提示换显示名再搜', () => {
    const text = summarizeFindUsages(
      response({ blueprint_count: 0, match_count: 0, blueprints: [] })
    )
    expect(text).toContain('没有蓝图匹配')
    expect(text).toContain('显示名')
    expect(text).not.toContain('结果可能不全')
  })

  it('超时交部分结果也算不全', () => {
    const text = summarizeFindUsages(response({ timed_out: true }))
    expect(text).toContain('搜索超时')
  })

  it('请过 Index All 时，下一步是等用户在确认框里点完再搜', () => {
    const text = summarizeFindUsages(
      response({
        coverage: {
          unindexed: 5,
          out_of_date: 0,
          failed_to_index: 0,
          indexing_in_progress: false,
          asset_discovery_in_progress: false,
          complete: false
        },
        index_all: { status: 'confirm_dialog_shown' }
      })
    )
    expect(text).toContain('确认框')
    expect(text).not.toContain('index_unindexed: true')
  })

  it('项目禁用了 Index All 时照实说', () => {
    const text = summarizeFindUsages(
      response({
        coverage: {
          unindexed: 5,
          out_of_date: 0,
          failed_to_index: 0,
          indexing_in_progress: false,
          asset_discovery_in_progress: false,
          complete: false
        },
        index_all: { status: 'disabled_by_settings' }
      })
    )
    expect(text).toContain('AllowIndexAllBlueprints')
  })

  it('截断时说只列了前几个', () => {
    const text = summarizeFindUsages(response({ blueprint_count: 80, truncated: true }))
    expect(text.split('\n')[0]).toContain('只列了前 2 个')
  })
})

describe('执行', () => {
  it('正常回包：summary 在前，透传覆盖情况，不带 object_path', async () => {
    callRequest.mockResolvedValue(response())
    const result = await run({ query: 'ApplyDamage' })
    expect(result.success).toBe(true)
    expect(Object.keys(result)[1]).toBe('summary')
    expect(result.blueprint_count).toBe(2)
    expect((result.coverage as { complete: boolean }).complete).toBe(true)
    expect(JSON.stringify(result.blueprints)).not.toContain('object_path')
  })

  it('插件报错（没有 blueprints 数组）时报失败，不说「没有蓝图匹配」', async () => {
    callRequest.mockResolvedValue({ ok: false, error: 'query is required', __rpc: { code: 400 } })
    const result = await run({ query: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toBe('query is required')
  })

  it('旧插件不认这个命令时提示更新插件', async () => {
    callRequest.mockResolvedValue(undefined)
    const result = await run({ query: 'x' })
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('插件')
  })

  it('引擎没连上时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)
    const result = await run({ query: 'x' })
    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('实测后补的两条', () => {
  /** 新工程里「过旧」几乎全是引擎自带蓝图：搜过了，只是可能漏项，不该为它们弹框重建索引 */
  it('只有过旧、没有未索引时不建议 index_unindexed', () => {
    const line = describeIncompleteness({
      ok: true,
      query: 'x',
      blueprint_count: 0,
      match_count: 0,
      truncated: false,
      timed_out: false,
      blueprints: [],
      coverage: {
        unindexed: 0,
        out_of_date: 55,
        failed_to_index: 0,
        indexing_in_progress: false,
        asset_discovery_in_progress: false,
        complete: false
      }
    } as Parameters<typeof describeIncompleteness>[0])

    expect(line).toContain('可能漏项')
    expect(line).not.toContain('index_unindexed')
  })

  it('项目的蓝图排前面，引擎和插件自带的标出来', () => {
    const text = summarizeFindUsages({
      ok: true,
      query: 'PrintString',
      blueprint_count: 2,
      match_count: 2,
      truncated: false,
      timed_out: false,
      blueprints: [
        { path: '/Engine/Tutorial/BP_X.BP_X', match_count: 1, matches: [] },
        { path: '/Game/FiB/BP_A.BP_A', match_count: 1, matches: [] }
      ],
      coverage: {
        unindexed: 0,
        out_of_date: 0,
        failed_to_index: 0,
        indexing_in_progress: false,
        asset_discovery_in_progress: false,
        complete: true
      }
    } as Parameters<typeof summarizeFindUsages>[0])

    const lines = text.split('\n')
    expect(lines[0]).toContain('1 个是引擎或插件自带的')
    expect(lines[1]).toContain('/Game/FiB/BP_A')
    expect(lines[2]).toContain('［引擎/插件自带］/Engine/Tutorial/BP_X')
  })
})
