import { unwrapResult } from '@renderer/common/utils'

export const tagAPI = {
  async getAll(): Promise<Tag[]> {
    const res = await window.api.database.tag.getAll()
    return unwrapResult<Tag[]>(res, '获取标签列表失败')
  },
  async getById(id: number): Promise<Tag | null> {
    const res = await window.api.database.tag.getById(id)
    return unwrapResult<Tag | null>(res, '获取标签详情失败')
  },
  async getByName(name: string): Promise<Tag | null> {
    const res = await window.api.database.tag.getByName(name)
    return unwrapResult<Tag | null>(res, '获取标签详情失败')
  },
  async getByGroupId(groupId: number): Promise<Tag[]> {
    const res = await window.api.database.tag.getByGroupId(groupId)
    return unwrapResult<Tag[]>(res, '获取分组标签失败')
  },
  async getUngrouped(): Promise<Tag[]> {
    const res = await window.api.database.tag.getUngrouped()
    return unwrapResult<Tag[]>(res, '获取未分组标签失败')
  },
  async create(tagData: Tag): Promise<{ id: number }> {
    const res = await window.api.database.tag.create(tagData)
    return unwrapResult<{ id: number }>(res, '创建标签失败')
  },
  async update(id: number, updates: Partial<Tag>): Promise<{ updated: boolean }> {
    const res = await window.api.database.tag.update(id, updates)
    return unwrapResult<{ updated: boolean }>(res, '更新标签失败')
  },
  async delete(id: number): Promise<{ deleted: boolean }> {
    const res = await window.api.database.tag.delete(id)
    return unwrapResult<{ deleted: boolean }>(res, '删除标签失败')
  },
  async search(keyword: string): Promise<Tag[]> {
    const res = await window.api.database.tag.search(keyword)
    return unwrapResult<Tag[]>(res, '搜索标签失败')
  },
  async batchCreate(tagsData: Tag[]): Promise<{ createdCount: number }> {
    const res = await window.api.database.tag.batchCreate(tagsData)
    return unwrapResult<{ createdCount: number }>(res, '批量创建标签失败')
  },
  async batchDelete(ids: number[]): Promise<{ deletedCount: number; total: number }> {
    const res = await window.api.database.tag.batchDelete(ids)
    return unwrapResult<{ deletedCount: number; total: number }>(res, '批量删除标签失败')
  },
  async moveToGroup(
    tagIds: number[],
    groupId: number | null
  ): Promise<{ updatedCount: number; total: number }> {
    const res = await window.api.database.tag.moveToGroup(tagIds, groupId)
    return unwrapResult<{ updatedCount: number; total: number }>(res, '移动标签到分组失败')
  },
  async getFavorites(): Promise<Tag[]> {
    const res = await window.api.database.tag.getFavorites()
    return unwrapResult<Tag[]>(res, '获取收藏标签失败')
  },
  async toggleFavorite(id: number): Promise<{ updated: boolean }> {
    const res = await window.api.database.tag.toggleFavorite(id)
    return unwrapResult<{ updated: boolean }>(res, '切换标签收藏状态失败')
  }
}

export default tagAPI
