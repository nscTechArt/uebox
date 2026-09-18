import { describe, expect, it } from 'vitest'
import { buildFolderSearchTree } from './folderSearchTree'

const folder = (
  folderKey: string,
  folderName: string,
  fatherKey?: string,
  hasChildren = false
): AssetFolder => ({
  folderKey,
  folderName,
  fatherKey,
  type: 'normal',
  hasChildren
})

describe('buildFolderSearchTree', () => {
  it('builds a visible ancestor branch for deep global folder matches', () => {
    const result = buildFolderSearchTree([
      folder('role', '角色', 'ALL', true),
      folder('hero', '哈珀', 'role', true),
      folder('music', '音乐', 'hero')
    ])

    expect(result.treeData).toHaveLength(1)
    expect(result.treeData[0].key).toBe('ALL')
    expect(result.treeData[0].children?.[0].key).toBe('role')
    expect(result.treeData[0].children?.[0].children?.[0].key).toBe('hero')
    expect(result.treeData[0].children?.[0].children?.[0].children?.[0].key).toBe('music')
    expect(result.expandedKeys).toEqual(['ALL', 'role', 'hero'])
  })

  it('keeps matches visible when an ancestor is unavailable', () => {
    const result = buildFolderSearchTree([folder('music', '音乐', 'missing-parent')])

    expect(result.treeData[0].key).toBe('ALL')
    expect(result.treeData[0].children?.[0].key).toBe('music')
    expect(result.expandedKeys).toEqual(['ALL'])
  })
})
