import { unwrapResult } from '@renderer/common/utils'

export const assetTagAPI = {
  async add(assetKey: string, tagId: number): Promise<number> {
    const res = await window.api.database.assetTag.add(assetKey, tagId)
    return unwrapResult<number>(res, '添加资产标签失败')
  },
  async remove(assetKey: string, tagId: number): Promise<boolean> {
    const res = await window.api.database.assetTag.remove(assetKey, tagId)
    return unwrapResult<boolean>(res, '移除资产标签失败')
  },
  async getTagIdsByAssetKey(assetKey: string): Promise<number[]> {
    const res = await window.api.database.assetTag.getTagIdsByAssetKey(assetKey)
    return unwrapResult<number[]>(res, '获取资产标签ID失败')
  },
  async getAssetsByTagId(tagId: number): Promise<AssetData[]> {
    const res = await window.api.database.assetTag.getAssetsByTagId(tagId)
    return unwrapResult<AssetData[]>(res, '获取标签下资产失败')
  },
  async getAssetsByAnyTag(tagIds: number[]): Promise<AssetData[]> {
    const res = await window.api.database.assetTag.getAssetsByAnyTag(tagIds)
    return unwrapResult<AssetData[]>(res, '按任意标签获取资产失败')
  },
  async getAssetsByAllTags(tagIds: number[]): Promise<AssetData[]> {
    const res = await window.api.database.assetTag.getAssetsByAllTags(tagIds)
    return unwrapResult<AssetData[]>(res, '按全部标签获取资产失败')
  },
  async setTagsForAsset(
    assetKey: string,
    tagIds: number[]
  ): Promise<{ added: number; deleted: number }> {
    const res = await window.api.database.assetTag.setTagsForAsset(assetKey, tagIds)
    return unwrapResult<{ added: number; deleted: number }>(res, '设置资产标签失败')
  },
  async filterAssets(options: TagFilterOptions): Promise<AssetData[]> {
    const res = await window.api.database.assetTag.filterAssets(options)
    return unwrapResult<AssetData[]>(res, '按标签筛选资产失败')
  }
}

export default assetTagAPI
