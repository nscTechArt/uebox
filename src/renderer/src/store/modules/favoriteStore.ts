import { defineStore } from 'pinia'
import { favoriteAPI } from '@renderer/api/favorite'
import { useVaultStore } from './vaultStore'

export const useFavoriteStore = defineStore('favorite', {
  state: () => ({
    totalCount: 0 as number,
    loading: false as boolean
  }),
  actions: {
    async refreshTotalCount(userId?: number, vaultId?: string): Promise<void> {
      this.loading = true
      try {
        // 如果未传入 vaultId，则使用当前保管库
        const vaultStore = useVaultStore()
        const activeVaultId = vaultId || vaultStore.currentVault?.id || null
        const count = await favoriteAPI.getFavoriteCount(userId, activeVaultId || undefined)
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
