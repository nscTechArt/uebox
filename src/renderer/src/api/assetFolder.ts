import { unwrapResult } from '@renderer/common/utils'
import i18n from '@renderer/i18n'

/**
 * 主进程删共享盘目录失败时给的机器码。
 *
 * 它不是「顺便报个错」—— 目录没删掉时主进程会**放弃**这次删除，库里的记录原样留着，
 * 所以这条消息必须让用户知道「可以重试」，而不是「删了但有点小问题」。
 */
const NETWORK_DIR_DELETE_FAILED = 'NETWORK_DIR_DELETE_FAILED'

function describeFolderDeleteFailure(
  // `data` 在成功和失败两种返回里形状不同（成功时是删除计数），所以按 unknown 收、
  // 在下面窄化 —— 写死失败那一种的话，调用方传成功返回值就编译不过
  res: { code?: string; error?: string; data?: unknown },
  fallback: string
): string {
  if (res.code === NETWORK_DIR_DELETE_FAILED) {
    const reason = res.error || 'unknown'
    /*
     * 批量删除是并行发出去的，所以「失败」几乎总是**部分失败**：
     * 有几个目录在 NAS 上已经没了，而它们的记录因为数据库那一步整个跳过还留在库里。
     *
     * 只说「删除失败」的话，用户看到的是文件夹一个没少，其中几个点进去是空的 ——
     * 他会以为是自己网络卡了，而实际上那几个已经永久消失。数目必须说出来。
     */
    const removedCount = (res.data as { removedCount?: number } | undefined)?.removedCount ?? 0
    if (removedCount > 0) {
      return i18n.global.t('assetFileList.delete.networkDirPartial', {
        removed: removedCount,
        reason
      })
    }
    return i18n.global.t('assetFileList.delete.networkDirFailed', { reason })
  }
  return res.error || fallback
}

export const assetFolderAPI = {
  async getAll(): Promise<AssetFolder[]> {
    const res = await window.api.database.assetFolder.getAll()
    return unwrapResult<AssetFolder[]>(res, '获取文件夹列表失败')
  },
  async getDeleted(
    page?: number,
    pageSize?: number
  ): Promise<{ list: AssetFolder[]; total: number } | AssetFolder[]> {
    const res = await window.api.database.assetFolder.getDeleted(page, pageSize)
    if (res.success) {
      return res.data
    }
    throw new Error(res.error || '获取回收站文件夹失败')
  },
  async getByKey(folderKey: string): Promise<AssetFolder | undefined> {
    const res = await window.api.database.assetFolder.getByKey(folderKey)
    return unwrapResult<AssetFolder | undefined>(res, '获取文件夹详情失败')
  },
  async getByFatherKey(
    fatherKey: string,
    sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
    sortOrder?: 'asc' | 'desc',
    limit?: number,
    offset?: number
  ): Promise<AssetFolder[]> {
    const res = await window.api.database.assetFolder.getByFatherKey(
      fatherKey,
      sortBy,
      sortOrder,
      limit,
      offset
    )
    return unwrapResult<AssetFolder[]>(res, '获取子文件夹失败')
  },
  async getChildCount(fatherKey: string): Promise<number> {
    const res = await window.api.database.assetFolder.getChildCount(fatherKey)
    return unwrapResult<number>(res, '获取子文件夹数量失败')
  },
  async getRootFolders(
    sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
    sortOrder?: 'asc' | 'desc'
  ): Promise<AssetFolder[]> {
    const res = await window.api.database.assetFolder.getRootFolders(sortBy, sortOrder)
    return unwrapResult<AssetFolder[]>(res, '获取根文件夹失败')
  },
  async create(folderData: AssetFolder): Promise<{ folderKey: string }> {
    const res = await window.api.database.assetFolder.create(folderData)
    // 主进程返回的是自增ID，这里统一返回我们提交的 folderKey，确保调用方一致性
    void unwrapResult<number>(res, '创建文件夹失败')
    return { folderKey: folderData.folderKey }
  },
  /**
   * `warning` 是「改成了，但有一半没跟上」：库里改完了，共享盘上的目录没改成。
   * 不是失败（所以不抛），但必须说出来 —— 不说的话资产路径指向一个不存在的目录，
   * 而用户只看到「重命名成功」。
   */
  async update(
    folderKey: string,
    folderData: Partial<AssetFolder>
  ): Promise<{ updated: boolean; warning?: { code: string; message: string } }> {
    const res = await window.api.database.assetFolder.update(folderKey, folderData)
    const ok = unwrapResult<boolean>(res, '更新文件夹失败')
    return { updated: ok, ...(res?.warning ? { warning: res.warning } : {}) }
  },
  async delete(folderKey: string): Promise<{ deleted: boolean }> {
    const res = await window.api.database.assetFolder.delete(folderKey)
    if (!res?.success) {
      throw new Error(describeFolderDeleteFailure(res ?? {}, '删除文件夹失败'))
    }
    return { deleted: res.data }
  },
  async hardDelete(folderKey: string): Promise<{ deleted: boolean }> {
    const res = await window.api.database.assetFolder.hardDelete(folderKey)
    const ok = unwrapResult<boolean>(res, '彻底删除文件夹失败')
    return { deleted: ok }
  },
  async batchDelete(folderKeys: string[]): Promise<{ deletedCount: number }> {
    const res = await window.api.database.assetFolder.batchDelete(folderKeys)
    if (res.success) {
      return { deletedCount: res.data?.deletedCount ?? 0 }
    }
    throw new Error(describeFolderDeleteFailure(res ?? {}, '批量删除文件夹失败'))
  },
  async restore(folderKey: string): Promise<{ restored: boolean }> {
    const res = await window.api.database.assetFolder.restore(folderKey)
    const ok = unwrapResult<boolean>(res, '恢复文件夹失败')
    return { restored: ok }
  },
  async getPathArray(folderKey: string): Promise<string[]> {
    const res = await window.api.database.assetFolder.getPathArray(folderKey)
    return unwrapResult<string[]>(res, '获取路径数组失败')
  },
  async getBatchPaths(folderKeys: string[]): Promise<Record<string, string[]>> {
    const res = await window.api.database.assetFolder.getBatchPaths(folderKeys)
    return unwrapResult<Record<string, string[]>>(res, '批量获取路径失败')
  },
  async getByDepth(depth: number): Promise<AssetFolder[]> {
    const res = await window.api.database.assetFolder.getByDepth(depth)
    return unwrapResult<AssetFolder[]>(res, '按层级获取文件夹失败')
  },
  async updatePathsRecursively(rootFolderKey: string): Promise<{ updated: boolean }> {
    const res = await window.api.database.assetFolder.updatePathsRecursively(rootFolderKey)
    const ok = unwrapResult<boolean>(res, '递归更新路径失败')
    return { updated: ok }
  },
  async clearDeleted(): Promise<{ cleared: boolean }> {
    const res = await window.api.database.assetFolder.clearDeleted()
    const ok = unwrapResult<boolean>(res, '清空回收站文件夹失败')
    return { cleared: ok }
  },
  async search(criteria: FolderSearchCriteria): Promise<AssetFolder[]> {
    const res = await window.api.database.assetFolder.search(criteria)
    return unwrapResult<AssetFolder[]>(res, '搜索文件夹失败')
  }
}

export default assetFolderAPI
