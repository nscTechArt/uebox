/**
 * @vitest-environment node
 *
 * 标签清单。打标签之前得先看得见库里已有什么，否则「树 / 树木 / Tree」会越攒越多。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAllTags, getAllTagGroups, getAssetCountsByTag } = vi.hoisted(() => ({
  getAllTags: vi.fn(),
  getAllTagGroups: vi.fn(),
  getAssetCountsByTag: vi.fn()
}))

vi.mock('../../../../sqliteDataBase', () => ({
  getPublicDatabase: () => ({}),
  getVaultDatabase: () => ({})
}))
vi.mock('../../../../sqliteDataBase/models/tag', () => ({ getAllTags }))
vi.mock('../../../../sqliteDataBase/models/tagGroup', () => ({ getAllTagGroups }))
vi.mock('../../../../sqliteDataBase/models/assetTag', () => ({ getAssetCountsByTag }))

import { createListTagsTool } from './listTags'

const tool = createListTagsTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

beforeEach(() => {
  getAllTags.mockReset().mockReturnValue([
    { id: 1, name: '角色', group_id: 10 },
    { id: 2, name: '树木', group_id: null },
    { id: 3, name: '一次性', group_id: null }
  ])
  getAllTagGroups.mockReset().mockReturnValue([{ id: 10, name: '用途' }])
  getAssetCountsByTag.mockReset().mockReturnValue([
    { tagId: 1, count: 12 },
    { tagId: 2, count: 3 }
  ])
})

describe('list_tags', () => {
  it('按用量从多到少排，孤儿标签沉底', async () => {
    const r = await run({})

    const tags = r.tags as Array<{ name: string; assets: number; group?: string }>
    expect(tags.map((t) => t.name)).toEqual(['角色', '树木', '一次性'])
    expect(tags[0]).toMatchObject({ assets: 12, group: '用途' })
    // 一个资产都没挂的标签算 0，不是 undefined —— 它正是整理时该被提议合并的那种
    expect(tags[2].assets).toBe(0)
  })

  it('没分组的标签不硬塞一个组名', async () => {
    const tags = (await run({})).tags as Array<{ group?: string }>
    expect(tags[1].group).toBeUndefined()
  })

  it('按名字过滤', async () => {
    const r = await run({ query: '树' })

    expect((r.tags as Array<{ name: string }>).map((t) => t.name)).toEqual(['树木'])
    expect(r.count).toBe(1)
  })

  it('超过 limit 时明说被截断了', async () => {
    const r = await run({ limit: 1 })

    expect(r.truncated).toBe(true)
    expect(r.returnedCount).toBe(1)
    expect(String(r.message)).toContain('前 1 个')
  })
})
