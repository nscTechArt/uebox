import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssetTree } from './useAssetTree'

const mocks = vi.hoisted(() => {
  const assetFolderAPI = {
    getRootFolders: vi.fn(),
    getByFatherKey: vi.fn(),
    getByKey: vi.fn(),
    getPathArray: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }

  return {
    assetFolderAPI,
    assetDataAPI: {
      getByFolderKey: vi.fn()
    }
  }
})

vi.mock('@renderer/api/assetFolder', () => ({
  assetFolderAPI: mocks.assetFolderAPI,
  default: mocks.assetFolderAPI
}))

vi.mock('@renderer/api/assetData', () => ({
  default: mocks.assetDataAPI,
  assetDataAPI: mocks.assetDataAPI
}))

const folder = (
  folderKey: string,
  folderName: string,
  fatherKey: string,
  hasChildren = false
): AssetFolder => ({
  folderKey,
  folderName,
  fatherKey,
  type: 'normal',
  hasChildren
})

describe('useAssetTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hydrates expanded nodes even when restored children are only partially cached', async () => {
    const tree = useAssetTree()
    tree.treeData.value = [
      {
        key: 'ALL',
        title: 'ALL',
        type: 'folder',
        path: '/ALL',
        isLeaf: false,
        children: [
          {
            key: 'role',
            title: '角色',
            type: 'folder',
            path: '/ALL/角色',
            isLeaf: false,
            children: [
              {
                key: 'witch',
                title: '老鼠女',
                type: 'folder',
                path: '/ALL/角色/老鼠女',
                isLeaf: true
              }
            ]
          }
        ]
      }
    ]
    tree.expandedKeys.value = ['ALL', 'role']

    mocks.assetFolderAPI.getByFatherKey.mockImplementation(async (fatherKey: string) => {
      if (fatherKey === 'ALL') return [folder('role', '角色', 'ALL', true)]
      if (fatherKey === 'role') {
        return [
          folder('witch', '老鼠女', 'role'),
          folder('guard', '护卫02六头身', 'role'),
          folder('cow', '奶牛', 'role')
        ]
      }
      return []
    })

    await tree.hydrateExpandedNodes()

    const roleNode = tree.findNodeByKey('role')
    expect(roleNode?.children?.map((child) => child.title)).toEqual([
      '老鼠女',
      '护卫02六头身',
      '奶牛'
    ])
  })

  it('hydrates deep expanded branches after the root tree is reloaded', async () => {
    const tree = useAssetTree()
    tree.treeData.value = [
      {
        key: 'ALL',
        title: 'ALL',
        type: 'folder',
        path: '/ALL',
        isLeaf: false,
        childrenLoaded: true,
        children: [
          {
            key: 'role',
            title: '角色',
            type: 'folder',
            path: '/ALL/角色',
            isLeaf: false,
            childrenLoaded: false
          }
        ]
      }
    ]
    tree.expandedKeys.value = ['ALL', 'role', 'hero']

    mocks.assetFolderAPI.getByFatherKey.mockImplementation(async (fatherKey: string) => {
      if (fatherKey === 'role') return [folder('hero', '哈珀', 'role', true)]
      if (fatherKey === 'hero') return [folder('tex', 'Tex', 'hero')]
      return []
    })

    await tree.hydrateExpandedNodes()

    const heroNode = tree.findNodeByKey('hero')
    expect(heroNode?.children?.map((child) => child.key)).toEqual(['tex'])
  })

  it('materialises a freshly imported branch when refreshing a node the tree has never seen', async () => {
    const tree = useAssetTree()
    // 刚建好的保管库：树上只有 ALL，虚幻插件这次导入才建出「版本/项目」两级
    tree.treeData.value = [
      {
        key: 'ALL',
        title: 'ALL',
        type: 'folder',
        path: '/ALL',
        isLeaf: false,
        childrenLoaded: true,
        children: []
      }
    ]

    // 插件用裸 SQL 建的文件夹没有 pathArray，只能走 fatherKey 链回退
    mocks.assetFolderAPI.getPathArray.mockResolvedValue([])
    mocks.assetFolderAPI.getByKey.mockImplementation(async (folderKey: string) => {
      if (folderKey === 'ue_5_5_0') return folder('ue_5_5_0', 'UE5.5.0', 'ALL', true)
      if (folderKey === 'proj_x') return folder('proj_x', 'UALinkDev55', 'ue_5_5_0', true)
      return null
    })
    mocks.assetFolderAPI.getByFatherKey.mockImplementation(async (fatherKey: string) => {
      if (fatherKey === 'ALL') return [folder('ue_5_5_0', 'UE5.5.0', 'ALL', true)]
      if (fatherKey === 'ue_5_5_0') return [folder('proj_x', 'UALinkDev55', 'ue_5_5_0', true)]
      if (fatherKey === 'proj_x') {
        return [folder('pcg', 'PCG', 'proj_x'), folder('sostylized', 'SoStylized', 'proj_x')]
      }
      return []
    })

    await tree.refreshNodeChildren('proj_x')

    expect(tree.findNodeByKey('ue_5_5_0')).not.toBeNull()
    expect(tree.findNodeByKey('proj_x')?.children?.map((child) => child.key)).toEqual([
      'pcg',
      'sostylized'
    ])
    expect(tree.expandedKeys.value).toContain('ue_5_5_0')
  })

  it('reloads a partial parent branch when navigating to a folder from the file grid', async () => {
    const tree = useAssetTree()
    tree.treeData.value = [
      {
        key: 'ALL',
        title: 'ALL',
        type: 'folder',
        path: '/ALL',
        isLeaf: false,
        childrenLoaded: true,
        children: [
          {
            key: 'role',
            title: '角色',
            type: 'folder',
            path: '/ALL/角色',
            isLeaf: false,
            children: [
              {
                key: 'witch',
                title: '老鼠女',
                type: 'folder',
                path: '/ALL/角色/老鼠女',
                isLeaf: true
              }
            ]
          }
        ]
      }
    ]

    mocks.assetFolderAPI.getPathArray.mockResolvedValue(['ALL', 'role', 'cow'])
    mocks.assetFolderAPI.getByFatherKey.mockImplementation(async (fatherKey: string) => {
      if (fatherKey === 'role') {
        return [
          folder('witch', '老鼠女', 'role'),
          folder('guard', '护卫02六头身', 'role'),
          folder('cow', '奶牛', 'role')
        ]
      }
      return []
    })

    await expect(tree.navigateToFolder('cow')).resolves.toBe(true)

    const roleNode = tree.findNodeByKey('role')
    expect(roleNode?.children?.map((child) => child.key)).toEqual(['witch', 'guard', 'cow'])
    expect(tree.selectedKeys.value).toEqual(['cow'])
  })

  it('does not change the selected folder when navigation is cancelled during loading', async () => {
    const tree = useAssetTree()
    tree.treeData.value = [
      { key: 'ALL', title: 'ALL', type: 'folder', path: '/ALL', childrenLoaded: true }
    ]
    tree.selectedKeys.value = ['original']
    tree.currentPath.value = '/original'
    let finish!: (keys: string[]) => void
    mocks.assetFolderAPI.getPathArray.mockReturnValue(
      new Promise<string[]>((resolve) => {
        finish = resolve
      })
    )
    let active = true
    const navigating = tree.navigateToFolder('ALL', () => active)
    active = false
    finish(['ALL'])
    await expect(navigating).resolves.toBe(false)
    expect(tree.selectedKeys.value).toEqual(['original'])
    expect(tree.currentPath.value).toBe('/original')
  })
})
