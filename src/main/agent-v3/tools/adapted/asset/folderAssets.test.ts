/**
 * @vitest-environment node
 *
 * 文件夹展开成 assetKey。
 *
 * 守三条：解析不出来就**不返回任何 key**（宁可报错也不能悄悄按空集合干活）、
 * 分批必须说清楚还有没有下一批、同一个文件夹连续取两批不许漏也不许重。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveFolder, searchAssetsByCriteria } = vi.hoisted(() => ({
  resolveFolder: vi.fn(),
  searchAssetsByCriteria: vi.fn()
}))

vi.mock('./folderLookup', () => ({ resolveFolder }))
vi.mock('../../../../sqliteDataBase/models/assetSearch', () => ({ searchAssetsByCriteria }))

import { selectFolderAssetKeys } from './folderAssets'

const db = {} as never

/** 库里的资产按名字乱序放着 —— 展开时必须自己排出一个稳定顺序 */
const makeAssets = (count: number): Array<{ assetKey: string; assetName: string }> =>
  Array.from({ length: count }, (_, i) => ({
    assetKey: `k${String(i).padStart(3, '0')}`,
    assetName: `SM_${String(i).padStart(3, '0')}`
  })).reverse()

beforeEach(() => {
  resolveFolder.mockReset().mockReturnValue({
    folderKey: 'k_so',
    folder: { folderKey: 'k_so', folderName: 'SoStylized', fullPath: '/ALL/SoStylized' }
  })
  searchAssetsByCriteria.mockReset().mockReturnValue(makeAssets(5))
})

describe('展开文件夹', () => {
  it('默认连子文件夹一起算，并把文件夹名回给调用方', () => {
    const r = selectFolderAssetKeys(db, 'SoStylized')

    expect(searchAssetsByCriteria).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ folderKey: 'k_so', includeSubfolders: true })
    )
    expect(r.assetKeys).toHaveLength(5)
    expect(r.total).toBe(5)
    expect(r.hasMore).toBe(false)
    expect(r.folderLabel).toBe('/ALL/SoStylized')
  })

  it('includeSubfolders: false 时只要这一层', () => {
    selectFolderAssetKeys(db, 'SoStylized', { includeSubfolders: false })

    expect(searchAssetsByCriteria).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ includeSubfolders: false })
    )
  })

  it('根（ALL）不加文件夹约束 —— 那是整个库', () => {
    resolveFolder.mockReturnValue({ folderKey: 'ALL' })

    const r = selectFolderAssetKeys(db, 'ALL')

    expect(searchAssetsByCriteria).toHaveBeenCalledWith(db, {})
    expect(r.folderKey).toBe('ALL')
  })
})

describe('分批', () => {
  it('超过 limit 时说清楚还有下一批', () => {
    searchAssetsByCriteria.mockReturnValue(makeAssets(250))

    const r = selectFolderAssetKeys(db, 'SoStylized', { limit: 200 })

    expect(r.assetKeys).toHaveLength(200)
    expect(r.total).toBe(250)
    expect(r.hasMore).toBe(true)
    expect(r.nextOffset).toBe(200)
  })

  it('照着 nextOffset 取第二批：不漏也不重', () => {
    searchAssetsByCriteria.mockReturnValue(makeAssets(250))

    const first = selectFolderAssetKeys(db, 'SoStylized', { limit: 200 })
    const second = selectFolderAssetKeys(db, 'SoStylized', {
      limit: 200,
      offset: first.nextOffset
    })

    const all = [...(first.assetKeys ?? []), ...(second.assetKeys ?? [])]
    expect(second.assetKeys).toHaveLength(50)
    expect(second.hasMore).toBe(false)
    expect(new Set(all).size).toBe(250)
  })

  it('offset 越过末尾时给空批，而不是报成功搬完了', () => {
    const r = selectFolderAssetKeys(db, 'SoStylized', { limit: 200, offset: 999 })

    expect(r.assetKeys).toEqual([])
    expect(r.total).toBe(5)
    expect(r.hasMore).toBe(false)
  })
})

describe('解析不出来就不动手', () => {
  it('重名文件夹原样把错误抛回去，一个 key 都不返回', () => {
    resolveFolder.mockReturnValue({ error: '库里有 2 个叫「Textures」的文件夹' })

    const r = selectFolderAssetKeys(db, 'Textures')

    expect(r.error).toContain('2 个')
    expect(r.assetKeys).toBeUndefined()
    expect(searchAssetsByCriteria).not.toHaveBeenCalled()
  })
})
