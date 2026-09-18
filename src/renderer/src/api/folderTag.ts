import { unwrapResult } from '@renderer/common/utils'

export interface FolderItem {
  id: string
  name: string
  parent_id: string | null
  [key: string]: any
}

export const folderTagAPI = {
  async add(folderKey: string, tagId: number): Promise<number> {
    const res = await window.api.database.folderTag.add(folderKey, tagId)
    return unwrapResult<number>(res, '添加文件夹标签失败')
  },
  async remove(folderKey: string, tagId: number): Promise<boolean> {
    const res = await window.api.database.folderTag.remove(folderKey, tagId)
    return unwrapResult<boolean>(res, '移除文件夹标签失败')
  },
  async getTagIdsByFolderKey(folderKey: string): Promise<number[]> {
    const res = await window.api.database.folderTag.getTagIdsByFolderKey(folderKey)
    return unwrapResult<number[]>(res, '获取文件夹标签ID失败')
  },
  async getFoldersByTagId(tagId: number): Promise<AssetFolder[]> {
    const res = await window.api.database.folderTag.getFoldersByTagId(tagId)
    return unwrapResult<AssetFolder[]>(res as any, '获取标签下文件夹失败')
  },
  async setTagsForFolder(
    folderKey: string,
    tagIds: number[]
  ): Promise<{ added: number; deleted: number }> {
    const res = await window.api.database.folderTag.setTagsForFolder(folderKey, tagIds)
    return unwrapResult<{ added: number; deleted: number }>(res, '设置文件夹标签失败')
  }
}

export default folderTagAPI
