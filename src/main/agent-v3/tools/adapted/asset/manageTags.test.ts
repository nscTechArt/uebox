/**
 * @vitest-environment node
 *
 * 标签的改名/改色，和下线（可选合并）。
 *
 * 守的几条：改名撞名要指路去合并而不是抛 UNIQUE、合并不能让资产少标签、
 * 删标签必须连关联行一起清（跨库没有外键级联）、认不准就整批不动。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAllTags,
  getTagById,
  updateTag,
  deleteTag,
  getAssetKeysByTagId,
  addAssetTag,
  removeAllAssetTagsByTagId,
  send
} = vi.hoisted(() => ({
  getAllTags: vi.fn(),
  getTagById: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  getAssetKeysByTagId: vi.fn(),
  addAssetTag: vi.fn(),
  removeAllAssetTagsByTagId: vi.fn(),
  send: vi.fn()
}))

vi.mock('../../../../sqliteDataBase', () => ({
  getPublicDatabase: () => ({}),
  getVaultDatabase: () => ({})
}))
vi.mock('../../../../sqliteDataBase/models/tag', () => ({
  getAllTags,
  getTagById,
  updateTag,
  deleteTag
}))
vi.mock('../../../../sqliteDataBase/models/assetTag', () => ({
  getAssetKeysByTagId,
  addAssetTag,
  removeAllAssetTagsByTagId
}))
vi.mock('../../../../appWindows', () => ({ getAppWindows: () => [{ webContents: { send } }] }))

import { createDeleteTagsTool, createManageTagsTool } from './manageTags'

const manage = createManageTagsTool()
const remove = createDeleteTagsTool()
const run = (
  tool: typeof manage,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** 库里的标签，id → 行。updateTag/deleteTag 就地改它，回读读的也是它 */
let tags: Map<number, { id: number; name: string; color?: string; is_favorite?: boolean }>

beforeEach(() => {
  tags = new Map([
    [1, { id: 1, name: '树', color: '#1890ff' }],
    [2, { id: 2, name: '树木', color: '#1890ff' }],
    [3, { id: 3, name: 'Tree', color: '#1890ff' }]
  ])
  getAllTags.mockReset().mockImplementation(() => [...tags.values()])
  getTagById.mockReset().mockImplementation((_db: unknown, id: number) => tags.get(id) ?? null)
  updateTag
    .mockReset()
    .mockImplementation((_db: unknown, id: number, updates: Record<string, unknown>) => {
      const row = tags.get(id)
      if (!row) return false
      if (updates.name !== undefined) row.name = String(updates.name)
      if (updates.color !== undefined) row.color = String(updates.color)
      if (updates.is_favorite !== undefined) row.is_favorite = updates.is_favorite === true
      return true
    })
  deleteTag.mockReset().mockImplementation((_db: unknown, id: number) => tags.delete(id))
  getAssetKeysByTagId.mockReset().mockReturnValue(['a1', 'a2'])
  addAssetTag.mockReset()
  removeAllAssetTagsByTagId.mockReset().mockReturnValue(2)
  send.mockReset()
})

describe('manage_tags', () => {
  it('改名之后回读确认，并通知界面', async () => {
    const r = await run(manage, { tag: '树木', newName: '树_旧' })

    expect(tags.get(2)?.name).toBe('树_旧')
    expect(r.success).toBe(true)
    expect(send).toHaveBeenCalledWith('asset:changed', expect.objectContaining({ op: 'tag' }))
  })

  it('改名撞上已有标签时指路去合并 —— 而不是抛一句 UNIQUE 约束', async () => {
    const r = await run(manage, { tag: '树木', newName: '树' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('delete_tags')
    expect(String(r.error)).toContain('mergeInto')
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('颜色格式不对直接挡，不写进库', async () => {
    const r = await run(manage, { tag: '树', color: '蓝色' })

    expect(r.success).toBe(false)
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('什么都不给时拒绝，不空跑一趟', async () => {
    const r = await run(manage, { tag: '树' })

    expect(r.success).toBe(false)
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('库里没有这个标签时说清楚去哪儿看', async () => {
    const r = await run(manage, { tag: '不存在', newName: 'x' })

    expect(String(r.error)).toContain('list_tags')
  })

  it('回读发现没改上就报「没有确认」', async () => {
    updateTag.mockReturnValue(false) // 底层没写进去

    const r = await run(manage, { tag: '树木', newName: '灌木' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('没有确认')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('delete_tags：合并', () => {
  it('资产先改挂到目标标签，再删旧标签 —— 一个资产都不会少标签', async () => {
    const r = await run(remove, { tags: ['树木', 'Tree'], mergeInto: '树' })

    expect(addAssetTag).toHaveBeenCalledWith(expect.anything(), { assetKey: 'a1', tagId: 1 })
    expect(addAssetTag).toHaveBeenCalledTimes(4) // 2 个标签 × 2 个资产
    expect(tags.has(2)).toBe(false)
    expect(tags.has(3)).toBe(false)
    expect(tags.has(1)).toBe(true)
    expect(r.merged_into).toBe('树')
    expect(r.success).toBe(true)
  })

  it('合并目标不存在时整批不动 —— 不能先删了再发现没地方搬', async () => {
    const r = await run(remove, { tags: ['树木'], mergeInto: '不存在的标签' })

    expect(r.success).toBe(false)
    expect(deleteTag).not.toHaveBeenCalled()
    expect(addAssetTag).not.toHaveBeenCalled()
  })

  it('目标标签同时出现在要删的清单里就报错 —— 那会把它自己删掉', async () => {
    const r = await run(remove, { tags: ['树', '树木'], mergeInto: '树' })

    expect(r.success).toBe(false)
    expect(deleteTag).not.toHaveBeenCalled()
  })
})

describe('delete_tags：纯删除', () => {
  it('连关联行一起清 —— 跨库没有外键级联，不清就是一堆孤儿行', async () => {
    const r = await run(remove, { tags: ['树木'] })

    expect(removeAllAssetTagsByTagId).toHaveBeenCalledWith(expect.anything(), 2)
    expect(addAssetTag).not.toHaveBeenCalled()
    expect(r.success).toBe(true)
    expect((r.results as Array<{ assets_untagged: number }>)[0].assets_untagged).toBe(2)
  })

  it('明说资产会少一个标签、而且删了恢复不了', async () => {
    const r = await run(remove, { tags: ['树木'] })

    expect(String(r.message)).toContain('少了一个标签')
    expect(String(r.message)).toContain('恢复不了')
  })

  it('一个认不准就整批不动', async () => {
    const r = await run(remove, { tags: ['树木', '不存在'] })

    expect(r.success).toBe(false)
    expect(deleteTag).not.toHaveBeenCalled()
  })

  it('回读发现标签还在就报「没有确认」', async () => {
    deleteTag.mockReturnValue(false) // 底层没删掉，标签还在

    const r = await run(remove, { tags: ['树木'] })

    const results = r.results as Array<{ status: string }>
    expect(results[0].status).toBe('unconfirmed')
    expect(r.success).toBe(false)
  })
})
