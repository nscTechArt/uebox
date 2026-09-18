import { defineStore } from 'pinia'
import { useAssetSelectionStore } from './assetSelectionStore'
import { useAssetViewStore } from './assetViewStore'

/**
 * 资产文件夹选择 Store
 * 目前主要用于 Spotlight 等全局入口快速定位到某个文件夹
 */
export const useAssetFolderStore = defineStore('assetFolder', {
  state: () => ({
    selectedFolderKey: null as string | null
  }),
  actions: {
    /**
     * 设置当前选中的文件夹
     * 会同步到资产选择 Store，并切换到资产视图
     */
    setSelectedFolder(folderKey: string | null): void {
      this.selectedFolderKey = folderKey

      // 确保视图在资产页
      const viewStore = useAssetViewStore()
      viewStore.ensureAssets()

      // 同步树节点选择
      const selectionStore = useAssetSelectionStore()
      selectionStore.setTreeKey(folderKey)

      // 通知可能的监听者（如资产管理页）刷新数据
      window.dispatchEvent(new CustomEvent('asset-folder:changed', { detail: { folderKey } }))
    }
  }
})
