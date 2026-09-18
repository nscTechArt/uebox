import { defineStore } from 'pinia'
import { tagAPI } from '@renderer/api/tag'

export const useTagStatsStore = defineStore('tagStats', {
  state: () => ({
    totalCount: 0 as number,
    loading: false as boolean
  }),
  actions: {
    async refreshTotalCount(): Promise<void> {
      this.loading = true
      try {
        const tags = await tagAPI.getAll()
        this.totalCount = Array.isArray(tags) ? tags.length : 0
      } catch (err) {
        console.error('刷新标签总数失败:', err)
        this.totalCount = 0
      } finally {
        this.loading = false
      }
    },
    setTotalCount(count: number): void {
      this.totalCount = Number.isFinite(count) ? count : 0
    }
  }
})
