import { defineStore } from 'pinia'
import { useVaultStore } from './vaultStore'
import { getActiveLibrarySource } from '@renderer/views/AssetManagement/data/activeLibrarySource'

export const useFavoriteStore = defineStore('favorite', {
  state: () => ({
    totalCount: 0 as number,
    loading: false as boolean
  }),
  actions: {
    async refreshTotalCount(_userId?: number, vaultId?: string): Promise<void> {
      this.loading = true
      try {
        // 如果未传入 vaultId，则使用当前保管库
        const vaultStore = useVaultStore()
        const activeVaultId = vaultId || vaultStore.currentVault?.id || null
        // 资产库页面在看服务器库时，数的是那个库在本机记的收藏
        const count = await getActiveLibrarySource().favorites.count(activeVaultId || undefined)
        this.totalCount = typeof count === 'number' ? count : 0
      } catch (err) {
        console.error('刷新收藏总数失败:', err)
        this.totalCount = 0
      } finally {
        this.loading = false
      }
    },
    setTotalCount(count: number): void {
      this.totalCount = Number.isFinite(count) ? count : 0
    },
    async notifyChanged(userId?: number, vaultId?: string): Promise<void> {
      // 供组件在新增/减少收藏后调用，统一触发数量刷新
      await this.refreshTotalCount(userId, vaultId)
    }
  }
})
