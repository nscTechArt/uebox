/**
 * @vitest-environment node
 *
 * 面数榜要把 Nanite 拆出去：Nanite 的帧开销不跟面数走，混在一张榜里，
 * 开了 Nanite 的大网格会占满前几名，把真正按面数付钱的网格挤出 limit。
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

import { createQueryAssetsTool, shouldSplitByNanite } from './queryAssets'

type ToolResult = { success?: boolean; data?: Record<string, unknown> }
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createQueryAssetsTool() as unknown as Executable).execute(input)

const asset = (
  name: string,
  nanite: boolean,
  triangles: number
): { name: string; path: string; type: string; stats: Record<string, unknown> } => ({
  name,
  path: `/Game/${name}`,
  type: 'StaticMesh',
  stats: { triangles, total_triangles: triangles * 10, instance_count: 10, nanite }
})

beforeEach(() => {
  callRequest.mockReset()
})

describe('什么时候拆', () => {
  it('默认（按总面数）且没给 nanite_enabled 时拆', () => {
    expect(shouldSplitByNanite({ limit: 20 })).toBe(true)
    expect(shouldSplitByNanite({ sort_by: 'TriangleCount', limit: 20 })).toBe(true)
  })

  it('调用方自己给了 nanite_enabled、或者不按面数排时不拆', () => {
    expect(shouldSplitByNanite({ conditions: { nanite_enabled: true }, limit: 20 })).toBe(false)
    expect(shouldSplitByNanite({ sort_by: 'InstanceCount', limit: 20 })).toBe(false)
    expect(shouldSplitByNanite({ sort_by: 'ResourceSize', limit: 20 })).toBe(false)
  })

  /** 在找问题网格时拆，会把开了 Nanite 的连同它们的缺碰撞等发现一起踢出主榜 */
  it('在找问题网格时不拆', () => {
    expect(shouldSplitByNanite({ conditions: { missing_collision: true }, limit: 20 })).toBe(false)
    expect(shouldSplitByNanite({ conditions: { shadow_casting: true }, limit: 20 })).toBe(false)
    expect(shouldSplitByNanite({ conditions: { nanite_enabled: false }, limit: 20 })).toBe(false)
  })

  /** 门槛和范围不是在找毛病；false 在插件里等于没给（默认就是 false） */
  it('只给门槛、范围或 false 时照拆', () => {
    expect(shouldSplitByNanite({ conditions: { min_triangles: 100000 }, limit: 20 })).toBe(true)
    expect(shouldSplitByNanite({ conditions: { min_instances: 50 }, limit: 20 })).toBe(true)
    expect(
      shouldSplitByNanite({ conditions: { class_filter: 'StaticMeshActor' }, limit: 20 })
    ).toBe(true)
    expect(
      shouldSplitByNanite({
        conditions: { missing_collision: false, shadow_casting: false },
        limit: 20
      })
    ).toBe(true)
    expect(shouldSplitByNanite({ conditions: {}, limit: 20 })).toBe(true)
  })
})

describe('面数榜', () => {
  it('主榜只查没开 Nanite 的，开了的另查一次单列', async () => {
    callRequest
      .mockResolvedValueOnce({ count: 1, assets: [asset('SM_Rock', false, 50_000)] })
      .mockResolvedValueOnce({ count: 1, assets: [asset('SM_Cliff', true, 2_000_000)] })

    const r = await run({ limit: 20 })

    expect(callRequest.mock.calls[0]![1]).toMatchObject({ conditions: { nanite_enabled: false } })
    // nanite_enabled: true 在插件里是「不排除」，回的是整体前 N 名；要 nanite_only 才只回 Nanite 的
    expect(callRequest.mock.calls[1]![1]).toMatchObject({
      conditions: { nanite_only: true },
      limit: 5
    })
    const data = r.data!
    expect((data.assets as { name: string }[]).map((a) => a.name)).toEqual(['SM_Rock'])
    expect((data.nanite_assets as { name: string }[]).map((a) => a.name)).toEqual(['SM_Cliff'])
    expect(data.ranking_note).toContain('Nanite')
  })

  it('单列那次查失败也不影响主榜', async () => {
    callRequest
      .mockResolvedValueOnce({ count: 1, assets: [asset('SM_Rock', false, 50_000)] })
      .mockRejectedValueOnce(new Error('timeout'))

    const r = await run({})

    expect(r.success).toBe(true)
    expect(r.data!.nanite_assets).toEqual([])
  })

  /** 旧插件不认 nanite_only，会回整体前 N 名 —— 单列里只留真开了 Nanite 的 */
  it('单列里只留真开了 Nanite 的', async () => {
    callRequest.mockResolvedValueOnce({ count: 0, assets: [] }).mockResolvedValueOnce({
      count: 2,
      assets: [asset('SM_Cliff', true, 2_000_000), asset('SM_Rock', false, 50_000)]
    })

    const r = await run({})

    expect((r.data!.nanite_assets as { name: string }[]).map((a) => a.name)).toEqual(['SM_Cliff'])
  })

  it('查缺碰撞时只查一次，开了 Nanite 的留在主榜', async () => {
    callRequest.mockResolvedValueOnce({ count: 1, assets: [asset('SM_Cliff', true, 2_000_000)] })

    const r = await run({ conditions: { missing_collision: true } })

    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(callRequest.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ conditions: { missing_collision: true } })
    )
    expect((r.data!.assets as { name: string }[]).map((a) => a.name)).toEqual(['SM_Cliff'])
    expect(r.data!.nanite_assets).toBeUndefined()
  })

  /** 描述里自己的例子：给了面数门槛照样拆，两次查询都带着门槛 */
  it('给了 min_triangles 时照拆，门槛两次都带上', async () => {
    callRequest
      .mockResolvedValueOnce({ count: 1, assets: [asset('SM_Rock', false, 150_000)] })
      .mockResolvedValueOnce({ count: 1, assets: [asset('SM_Cliff', true, 2_000_000)] })

    const r = await run({ conditions: { min_triangles: 100000 } })

    expect(callRequest).toHaveBeenCalledTimes(2)
    expect(callRequest.mock.calls[0]![1]).toMatchObject({
      conditions: { min_triangles: 100000, nanite_enabled: false }
    })
    expect(callRequest.mock.calls[1]![1]).toMatchObject({
      conditions: { min_triangles: 100000, nanite_only: true }
    })
    expect((r.data!.nanite_assets as { name: string }[]).map((a) => a.name)).toEqual(['SM_Cliff'])
  })

  it('调用方给了 nanite_enabled 时只查一次，原样转发', async () => {
    callRequest.mockResolvedValueOnce({ count: 0, assets: [] })

    const r = await run({ conditions: { nanite_enabled: true } })

    expect(callRequest).toHaveBeenCalledTimes(1)
    expect(callRequest.mock.calls[0]![1]).toMatchObject({ conditions: { nanite_enabled: true } })
    expect(r.data!.nanite_assets).toBeUndefined()
  })
})
