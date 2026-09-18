import type { InjectionKey } from 'vue'

export interface AssetContext {
  // 文件夹操作
  addFolder: (parentKey: string | null, folderName: string) => Promise<string | null>
  deleteFolder: (folderKey: string) => Promise<void>
  renameFolder: (folderKey: string, newName: string) => Promise<void>

  // 资产操作
  addAsset: (folderKey: string, assetName: string) => Promise<void>
  deleteAsset: (assetKey: string) => Promise<void>
  renameAsset: (assetKey: string, newName: string) => Promise<void>

  // 导航操作
  navigateToFolder: (folderKey: string) => Promise<boolean>
  refreshCurrentFolder: () => Promise<void>

  // 新增：拖拽移动后刷新树（带移动项）
  refreshTreeForMove: (
    sourceFolderKey: string | null | undefined,
    targetFolderKey: string,
    movedItems: Array<{ id: string; type: string }>
  ) => Promise<void>

  // 新增：更新树节点颜色（实时更新）
  updateTreeNodeColor: (nodeKey: string, color: string | null) => boolean

  // 新增：从树中移除已删除的文件夹节点（批量删除后同步树）
  removeTreeNodes: (folderKeys: string[]) => void

  /**
   * 重新拉一遍文件夹树（保留展开状态）。
   *
   * 回收站里恢复 / 彻底删除文件夹之后必须调：那两件事都在改树本身的内容，
   * 而不是「某个节点少了一个孩子」，removeTreeNodes 这种局部改法接不住。
   */
  refreshTree: () => Promise<void>

  // 乐观更新：从右侧文件列表移除指定的资产/文件夹（避免 client 角色 reload 脏数据）
  removeFiles: (keys: string[]) => void
}

export const AssetContextKey: InjectionKey<AssetContext> = Symbol('AssetContext')
