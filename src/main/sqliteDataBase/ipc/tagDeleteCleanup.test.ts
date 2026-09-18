/**
 * @vitest-environment node
 *
 * 删标签必须把当前保管库里的关联行一起清掉。
 *
 * 红灯来自一次真机检查：`db:tags:delete` 只做了公共库的
 * `DELETE FROM tags WHERE id = ?`，从头到尾不碰 `asset_tags`。
 * 标签在公共库、关联在每个保管库里，跨库没有外键级联，于是从界面删一个标签
 * 就在所有库里留下一批指向空 id 的悬空记录。
 *
 * agent 那条路径（tools/adapted/asset/manageTags）一直有清，界面这条没有 ——
 * 同一个操作走 AI 和走鼠标结果不一样。这里锁住界面这条不许再退回去。
 *
 * 注意这只解决**当前库**。别的保管库的库文件此刻没打开，清不了；
 * 那要等「标签清单按库存放」的改造，不在这个测试的射程里。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteTag, removeAllAssetTagsByTagId, handle } = vi.hoisted(() => ({
  deleteTag: vi.fn(),
  removeAllAssetTagsByTagId: vi.fn(),
  handle: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle } }))
vi.mock('../index', () => ({
  getPublicDatabase: () => ({ tag: 'public' }),
  getVaultDatabase: () => ({ tag: 'vault' })
}))
vi.mock('../dbUtils', () => ({
  transaction: async (_db: unknown, fn: (db: unknown) => unknown) => fn(_db)
}))
vi.mock('../models/assetTag', () => ({ removeAllAssetTagsByTagId }))
vi.mock('../models/tag', () => ({
  createTag: vi.fn(),
  getTagById: vi.fn(),
  getTagByName: vi.fn(),
  getAllTags: vi.fn(),
  getTagsByGroupId: vi.fn(),
  getUngroupedTags: vi.fn(),
  updateTag: vi.fn(),
  deleteTag,
  searchTags: vi.fn(),
  getFavoriteTags: vi.fn(),
  toggleTagFavorite: vi.fn()
}))

const { registerTagIPC } = await import('./tag')

/** 取出某个频道注册的处理函数 */
const handlerFor = (channel: string): ((...args: unknown[]) => Promise<unknown>) => {
  registerTagIPC()
  const entry = handle.mock.calls.find((call) => call[0] === channel)
  if (!entry) throw new Error(`没注册 ${channel}`)
  return entry[1] as (...args: unknown[]) => Promise<unknown>
}

describe('db:tags:delete', () => {
  beforeEach(() => {
    handle.mockReset()
    deleteTag.mockReset()
    removeAllAssetTagsByTagId.mockReset()
  })

  it('删成功就清掉当前保管库里的关联行', async () => {
    deleteTag.mockReturnValue(true)

    const result = await handlerFor('db:tags:delete')({}, 7)

    expect(result).toEqual({ success: true, data: { deleted: true } })
    expect(removeAllAssetTagsByTagId).toHaveBeenCalledWith({ tag: 'vault' }, 7)
  })

  it('标签本来就不存在（没删掉）就别去动关联表', async () => {
    deleteTag.mockReturnValue(false)

    await handlerFor('db:tags:delete')({}, 7)

    expect(removeAllAssetTagsByTagId).not.toHaveBeenCalled()
  })

  it('清关联失败不连累删除本身 —— 标签已经没了，悬空记录可以事后扫', async () => {
    deleteTag.mockReturnValue(true)
    removeAllAssetTagsByTagId.mockImplementation(() => {
      throw new Error('保管库没打开')
    })

    const result = await handlerFor('db:tags:delete')({}, 7)

    expect(result).toEqual({ success: true, data: { deleted: true } })
  })
})

describe('db:tags:batchDelete', () => {
  beforeEach(() => {
    handle.mockReset()
    deleteTag.mockReset()
    removeAllAssetTagsByTagId.mockReset()
  })

  it('逐个清，且只清真删掉了的那些', async () => {
    // 中间那个删不掉（比如已经被别处删了）
    deleteTag.mockImplementation((_db: unknown, id: number) => id !== 2)

    const result = await handlerFor('db:tags:batchDelete')({}, [1, 2, 3])

    expect(result).toEqual({ success: true, data: { deletedCount: 2, total: 3 } })
    expect(removeAllAssetTagsByTagId.mock.calls.map((call) => call[1])).toEqual([1, 3])
  })
})
