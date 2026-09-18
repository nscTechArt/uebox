import { unwrapResult } from '@renderer/common/utils'

export const tagGroupAPI = {
  async getAll(): Promise<TagGroup[]> {
    const res = await window.api.database.tagGroup.getAll()
    return unwrapResult<TagGroup[]>(res, '获取标签组列表失败')
  },
  async getAllWithCount(): Promise<Array<TagGroup & { tagCount: number }>> {
    const res = await window.api.database.tagGroup.getAllWithCount()
    return unwrapResult<Array<TagGroup & { tagCount: number }>>(res, '获取标签组计数失败')
  },
  async getById(id: number): Promise<TagGroup | null> {
    const res = await window.api.database.tagGroup.getById(id)
    return unwrapResult<TagGroup | null>(res, '获取标签组详情失败')
  },
  async getByName(name: string): Promise<TagGroup | null> {
    const res = await window.api.database.tagGroup.getByName(name)
    return unwrapResult<TagGroup | null>(res, '获取标签组详情失败')
  },
  async getTagCount(groupId: number): Promise<number> {
    const res = await window.api.database.tagGroup.getTagCount(groupId)
    return unwrapResult<number>(res, '获取标签组标签数失败')
  },
  async create(groupData: TagGroup): Promise<{ id: number }> {
    const res = await window.api.database.tagGroup.create(groupData)
    return unwrapResult<{ id: number }>(res, '创建标签组失败')
  },
  async update(id: number, updates: Partial<TagGroup>): Promise<{ updated: boolean }> {
    const res = await window.api.database.tagGroup.update(id, updates)
    return unwrapResult<{ updated: boolean }>(res, '更新标签组失败')
  },
  async delete(id: number): Promise<{ deleted: boolean }> {
    const res = await window.api.database.tagGroup.delete(id)
    return unwrapResult<{ deleted: boolean }>(res, '删除标签组失败')
  },
  async search(keyword: string): Promise<TagGroup[]> {
    const res = await window.api.database.tagGroup.search(keyword)
    return unwrapResult<TagGroup[]>(res, '搜索标签组失败')
  },
  async batchCreate(groupsData: TagGroup[]): Promise<{ createdCount: number }> {
    const res = await window.api.database.tagGroup.batchCreate(groupsData)
    return unwrapResult<{ createdCount: number }>(res, '批量创建标签组失败')
  },
  async batchDelete(ids: number[]): Promise<{ deletedCount: number; total: number }> {
    const res = await window.api.database.tagGroup.batchDelete(ids)
    return unwrapResult<{ deletedCount: number; total: number }>(res, '批量删除标签组失败')
  },
  async batchUpdateSort(
    sortData: Array<{ id: number; sort_order: number }>
  ): Promise<{ updated: boolean }> {
    const res = await window.api.database.tagGroup.batchUpdateSort(sortData)
    return unwrapResult<{ updated: boolean }>(res, '批量更新标签组排序失败')
  },
  async duplicate(id: number, newName?: string): Promise<{ id: number }> {
    const res = await window.api.database.tagGroup.duplicate(id, newName)
    return unwrapResult<{ id: number }>(res, '复制标签组失败')
  }
}

export default tagGroupAPI
