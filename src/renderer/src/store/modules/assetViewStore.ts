import { defineStore } from 'pinia'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { StorageUtils } from '../../common/utils/storage'

export type AssetViewMode = 'assets' | 'baiduyun' | 'tagManagement' | 'webdav'

// 基于标签页的状态存储
const tabStates = new Map<string, { mode: AssetViewMode }>()

// 导出 tabStates 以便外部访问（用于复制状态）
export function getTabStates() {
  return tabStates
}

export const useAssetViewStore = defineStore('assetView', {
  state: () => ({
    mode: 'assets' as AssetViewMode,
    _tabId: 'default' as string, // 当前标签页 ID
    /**
     * 标记树是否需要刷新
     * 当 Agent 在其他页面创建文件夹时，MainLayout 会设置此标记
     * AssetManagement 在 onActivated 时检查并刷新
     */
    pendingTreeRefresh: false as boolean,
    pendingRefreshPayload: null as { parentKey: string; createdCount: number } | null
  }),
  getters: {
    isAssets: (state): boolean => state.mode === 'assets',
    isBaiduyun: (state): boolean => state.mode === 'baiduyun',
    isTagManagement: (state): boolean => state.mode === 'tagManagement',
    isWebdav: (state): boolean => state.mode === 'webdav'
  },
  actions: {
    setTabId(tabId: string): void {
      this._tabId = tabId
      // 恢复该标签页的状态
      const savedState = tabStates.get(tabId)
      if (savedState) {
        this.mode = savedState.mode
      } else {
        // 保存当前状态
        tabStates.set(tabId, { mode: this.mode })
      }
    },
    setMode(mode: AssetViewMode): void {
      this.mode = mode
      // 保存当前标签页的状态
      const tabId = this._tabId || 'default'
      const state = tabStates.get(tabId) || { mode: 'assets' }
      state.mode = mode
      tabStates.set(tabId, state)
    },
    toggle(): void {
      this.mode = this.mode === 'assets' ? 'baiduyun' : 'assets'
      // 保存当前标签页的状态
      const tabId = this._tabId || 'default'
      const state = tabStates.get(tabId) || { mode: 'assets' }
      state.mode = this.mode
      tabStates.set(tabId, state)
    },
    ensureAssets(): void {
      this.mode = 'assets'
      const tabId = this._tabId || 'default'
      const state = tabStates.get(tabId) || { mode: 'assets' }
      state.mode = 'assets'
      tabStates.set(tabId, state)
    },
    ensureBaiduyun(): void {
      this.mode = 'baiduyun'
      const tabId = this._tabId || 'default'
      const state = tabStates.get(tabId) || { mode: 'assets' }
      state.mode = 'baiduyun'
      tabStates.set(tabId, state)
    },
    ensureTagManagement(): void {
      this.mode = 'tagManagement'
      const tabId = this._tabId || 'default'
      const state = tabStates.get(tabId) || { mode: 'assets' }
      state.mode = 'tagManagement'
      tabStates.set(tabId, state)
    },
    ensureWebdav(): void {
      this.mode = 'webdav'
      const tabId = this._tabId || 'default'
      const state = tabStates.get(tabId) || { mode: 'assets' }
      state.mode = 'webdav'
      tabStates.set(tabId, state)
    },
    /**
     * 标记资产树需要刷新
     * 由 MainLayout 在接收到 Agent 创建文件夹事件时调用
     */
    markTreeNeedsRefresh(payload: { parentKey: string; createdCount: number }): void {
      this.pendingTreeRefresh = true
      this.pendingRefreshPayload = payload
    },
    /**
     * 清除资产树刷新标记
     * 由 AssetManagement 在完成刷新后调用
     */
    clearTreeRefresh(): void {
      this.pendingTreeRefresh = false
      this.pendingRefreshPayload = null
    },
    // 复制状态到新的 tabId
    copyStateToTabId(sourceTabId: string, targetTabId: string): void {
      const sourceState = tabStates.get(sourceTabId)
      if (sourceState) {
        tabStates.set(targetTabId, { ...sourceState })
      }
    }
  },
  persist: usePersistOptions<{ mode: AssetViewMode }>({
    key: 'asset-view-store',
    paths: ['mode'],
    storage: 'localStorage',
    serializer: StorageUtils.createCustomSerializer()
  })
})
