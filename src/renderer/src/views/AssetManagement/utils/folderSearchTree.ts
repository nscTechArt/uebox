import type { TreeNode } from '../types'

const ALL_FOLDER_KEY = 'ALL'

const getFolderTitle = (folder: AssetFolder): string => folder.folderName || folder.folderKey

const getFolderParentKey = (folder: AssetFolder): string =>
  folder.folderKey === ALL_FOLDER_KEY ? '' : folder.fatherKey || ALL_FOLDER_KEY

const normalizeFolderType = (
  folderType: AssetFolder['type']
): TreeNode['folderType'] | undefined => {
  if (
    folderType === 'normal' ||
    folderType === 'plugin' ||
    folderType === 'project' ||
    folderType === 'system'
  ) {
    return folderType
  }
  return undefined
}

const sortFolders = (folders: AssetFolder[]): AssetFolder[] => {
  return [...folders].sort((a, b) => {
    if (a.folderKey === ALL_FOLDER_KEY) return -1
    if (b.folderKey === ALL_FOLDER_KEY) return 1
    return getFolderTitle(a).localeCompare(getFolderTitle(b), 'zh-Hans-CN')
  })
}

export function buildFolderSearchTree(folders: AssetFolder[]): {
  treeData: TreeNode[]
  expandedKeys: string[]
} {
  const folderMap = new Map<string, AssetFolder>()
  for (const folder of folders) {
    if (folder?.folderKey) {
      folderMap.set(folder.folderKey, folder)
    }
  }

  if (!folderMap.has(ALL_FOLDER_KEY)) {
    folderMap.set(ALL_FOLDER_KEY, {
      folderKey: ALL_FOLDER_KEY,
      fatherKey: undefined,
      folderName: ALL_FOLDER_KEY,
      type: 'normal',
      hasChildren: true
    })
  }

  const childrenByParent = new Map<string, AssetFolder[]>()
  for (const folder of folderMap.values()) {
    if (folder.folderKey === ALL_FOLDER_KEY) continue
    const rawParentKey = getFolderParentKey(folder)
    const parentKey = folderMap.has(rawParentKey) ? rawParentKey : ALL_FOLDER_KEY
    if (!childrenByParent.has(parentKey)) {
      childrenByParent.set(parentKey, [])
    }
    childrenByParent.get(parentKey)?.push(folder)
  }

  const expandedKeys = new Set<string>()
  const buildNode = (folder: AssetFolder, parentPath: string): TreeNode => {
    const title = getFolderTitle(folder)
    const path = parentPath ? `${parentPath}/${title}`.replace(/\/+/g, '/') : `/${title}`
    const childFolders = sortFolders(childrenByParent.get(folder.folderKey) || [])
    if (childFolders.length > 0) {
      expandedKeys.add(folder.folderKey)
    }
    const children = childFolders.map((child) => buildNode(child, path))

    return {
      key: folder.folderKey,
      title,
      type: 'folder',
      folderType: normalizeFolderType(folder.type),
      path,
      color: folder.color,
      img: folder.img,
      children,
      childrenLoaded: true,
      isLeaf: children.length === 0
    }
  }

  return {
    treeData: [buildNode(folderMap.get(ALL_FOLDER_KEY)!, '')],
    expandedKeys: [...expandedKeys]
  }
}
