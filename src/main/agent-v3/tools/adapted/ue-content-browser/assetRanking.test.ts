/**
 * @vitest-environment node
 *
 * 两个体积工具的输出契约。
 *
 * 这两个工具的全部价值是「让人看一眼就知道该动哪个」，所以测的不是
 * 请求发出去没有，而是**回来的东西能不能直接说给人听**：
 * 数字有没有换成人读的单位、占比算没算、截断有没有说出来。
 */

import { describe, expect, it, vi } from 'vitest'

const { callRequest } = vi.hoisted(() => ({ callRequest: vi.fn() }))
const { connectionCount } = vi.hoisted(() => ({ connectionCount: { value: 1 } }))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({
      callRequest,
      getConnectionCount: () => connectionCount.value
    })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => undefined
}))

import { createAssetRankingTool } from './assetRanking'
import { createSizeMapTool } from './sizeMap'
import { humanBytes } from './formatBytes'

const ranking = createAssetRankingTool()
const sizeMap = createSizeMapTool()

const run = (t: typeof ranking, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (t.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

describe('humanBytes', () => {
  it('按 1024 进位，三位数以上不留小数', () => {
    expect(humanBytes(0)).toBe('0 B')
    expect(humanBytes(512)).toBe('512 B')
    expect(humanBytes(1536)).toBe('1.5 KB')
    expect(humanBytes(432013312)).toBe('412 MB')
  })

  it('负数和 NaN 不产出 "-1 B" 这种鬼话', () => {
    expect(humanBytes(-1)).toBe('0 B')
    expect(humanBytes(Number.NaN)).toBe('0 B')
  })
})

describe('ue_project_asset_ranking', () => {
  it('先说哪一类占大头，再说具体是哪几个', async () => {
    callRequest.mockResolvedValueOnce({
      ok: true,
      scanned: 1200,
      total_disk_size: 432013312,
      scope_path: '/Game',
      truncated: true,
      assets: [{ name: 'T_Rock', path: '/Game/T_Rock', class: 'Texture2D', disk_size: 12582912 }],
      by_class: {
        Texture2D: { count: 800, disk_size: 400000000 },
        StaticMesh: { count: 400, disk_size: 32013312 }
      }
    })

    const r = await run(ranking, { path: '/Game' })

    expect(r.success).toBe(true)
    expect(String(r.summary)).toContain('Texture2D 800 个')
    expect(String(r.summary)).toContain('412 MB')
    // 截断了就要说，否则读的人会以为这就是全部
    expect(String(r.summary)).toContain('只返回了前')
    expect((r.assets as { disk_size_human: string }[])[0]!.disk_size_human).toBe('12.0 MB')
  })

  it('引擎侧的 notes 原样带回 —— 那里写着「磁盘体积不是运行时内存」', async () => {
    callRequest.mockResolvedValueOnce({
      ok: true,
      scanned: 1,
      total_disk_size: 10,
      assets: [],
      by_class: {},
      notes: ['disk_size is the compressed editor package on disk.']
    })

    const r = await run(ranking, {})

    expect(r.notes).toHaveLength(1)
  })

  it('没连引擎时直接说清楚，不发请求', async () => {
    connectionCount.value = 0
    callRequest.mockClear()

    const r = await run(ranking, {})

    expect(r.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
    connectionCount.value = 1
  })
})

describe('ue_asset_size_map', () => {
  it('每个依赖占整体的百分之多少要算出来', async () => {
    callRequest.mockResolvedValueOnce({
      ok: true,
      root: '/Game/Maps/Main',
      total_size: 1000,
      dependency_count: 42,
      top_contributors: [
        { path: '/Game/T_Huge', class: 'Texture2D', size: 600 },
        { path: '/Game/SM_Rock', class: 'StaticMesh', size: 100 }
      ]
    })

    const r = await run(sizeMap, { path: '/Game/Maps/Main' })

    const top = r.top_contributors as { share: number }[]
    expect(top[0]!.share).toBe(60)
    expect(String(r.summary)).toContain('42 个依赖')
    expect(String(r.summary)).toContain('占 60%')
  })

  it('展开不完时说明这是下限，不能当成总数', async () => {
    callRequest.mockResolvedValueOnce({
      ok: true,
      root: '/Game/Maps/Main',
      total_size: 1000,
      dependency_count: 5000,
      truncated: true,
      top_contributors: []
    })

    const r = await run(sizeMap, { path: '/Game/Maps/Main' })

    expect(String(r.summary)).toContain('下限')
  })

  /**
   * 404 是最常见的失败：模型手上是资产名不是路径。
   * 回一句「失败」它只会原样重试；告诉它下一步该调什么才有出路。
   */
  it('路径不存在时指出下一步该做什么', async () => {
    callRequest.mockResolvedValueOnce({
      ok: false,
      error: 'Package not found',
      __rpc: { code: 404 }
    })

    const r = await run(sizeMap, { path: '/Game/Nope' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('ue_content_search')
  })
})
