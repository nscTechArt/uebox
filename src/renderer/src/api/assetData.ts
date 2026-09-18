import { unwrapResult } from '@renderer/common/utils'
import { reportRemoteSync } from '@renderer/common/remoteSyncNotice'
import type { FolderImportOptions } from '@core/shared/assetImport'
import type { AssetImportStatusSummary } from '@core/shared/assetDependency'

export const assetDataAPI = {
  async cancelImport(taskId: string): Promise<void> {
    const result = await window.api.fs.cancelImport(taskId)
    // A scan may have just finished; renderer also remembers cancellation between phases.
    void result
  },
  async resolveImportError(taskId: string, action: string): Promise<void> {
    const result = await window.api.fs.resolveImportError(taskId, action)
    unwrapResult({ ...result, data: undefined })
  },
  async getAll(): Promise<AssetData[]> {
    const res = await window.api.database.assetData.getAll()
    return unwrapResult<AssetData[]>(res, '获取资产列表失败')
  },
  async getDistinctAssetTypes(): Promise<{ className: string; classNameCn: string }[]> {
    const res = await window.api.database.assetData.getDistinctAssetTypes()
    return unwrapResult<{ className: string; classNameCn: string }[]>(res, '获取资产类型列表失败')
  },
  async getById(assetKey: string): Promise<AssetData | undefined> {
    const res = await window.api.database.assetData.getById(assetKey)
    return unwrapResult<AssetData | undefined>(res, '获取资产详情失败')
  },
  /**
   * 这个资产引用的每一条依赖，在不在当前保管库里。
   * 一次带索引的批量查询，详情面板每换一个资产就会调一次。
   */
  async getImportStatus(assetKey: string): Promise<AssetImportStatusSummary> {
    const res = await window.api.database.assetData.getAssetImportStatus(assetKey)
    return unwrapResult<AssetImportStatusSummary>(res, '获取导入依赖失败')
  },
  async getByFolderKey(
    folderKey: string,
    sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
    sortOrder?: 'asc' | 'desc',
    showDependencies?: boolean,
    limit?: number,
    offset?: number
  ): Promise<AssetData[]> {
    const res = await window.api.database.assetData.getByFolderKey(
      folderKey,
      sortBy,
      sortOrder,
      showDependencies,
      limit,
      offset
    )
    return unwrapResult<AssetData[]>(res, '获取文件夹资产失败')
  },
  async getCountByFolderKey(folderKey: string, showDependencies?: boolean): Promise<number> {
    const res = await window.api.database.assetData.getCountByFolderKey(folderKey, showDependencies)
    return unwrapResult<number>(res, '获取文件夹资产数量失败')
  },
  async getByFolderKeyRecursive(
    folderKey: string,
    filters?: AssetDataFilter
  ): Promise<AssetData[]> {
    const res = await window.api.database.assetData.getByFolderKeyRecursive(folderKey, filters)
    return unwrapResult<AssetData[]>(res, '递归获取文件夹资产失败')
  },
  async searchByName(name: string): Promise<AssetData[]> {
    const res = await window.api.database.assetData.searchByName(name)
    return unwrapResult<AssetData[]>(res, '按名称搜索资产失败')
  },
  /**
   * 创建资产
   * @param assetData 资产数据
   * @returns 返回提交的 `assetKey`，主进程内部返回的是自增ID，这里统一返回我们提交的 `assetKey` 以保持调用方一致性
   */
  async create(assetData: AssetData): Promise<{ assetKey: string }> {
    const res = await window.api.database.assetData.create(assetData)
    void unwrapResult<number>(res, '创建资产失败')
    return { assetKey: assetData.assetKey }
  },
  async update(assetKey: string, assetData: Partial<AssetData>): Promise<{ updated: boolean }> {
    const res = await window.api.database.assetData.update(assetKey, assetData)
    const ok = unwrapResult<boolean>(res, '更新资产失败')
    // 本地写成功不代表已同步到资产服务器 —— 待同步时提示用户，别静默
    reportRemoteSync(res)
    return { updated: ok }
  },
  /**
   * 把一张 base64 图存成这个资产的缩略图。
   *
   * 存文件和写库要一起做：只存文件不写 imgLocalPath，界面下次拿到的还是旧图 ——
   * 看着就是"点了没反应"。
   */
  async saveThumbnail(assetKey: string, base64: string): Promise<string> {
    const saved = await window.api.asset.saveThumbnail(base64, assetKey)
    if (!saved.success || !saved.data) {
      throw new Error(saved.error || '保存缩略图失败')
    }
    await this.update(assetKey, { imgLocalPath: saved.data })
    return saved.data
  },
  async delete(assetKey: string): Promise<{ deleted: boolean }> {
    const res = await window.api.database.assetData.delete(assetKey)
    const ok = unwrapResult<boolean>(res, '删除资产失败')
    reportRemoteSync(res)
    return { deleted: ok }
  },
  /**
   * 一次彻底删掉一批。返回真正删掉的和没删成的 —— 「部分成功」必须能说出来，
   * 不能拿一个 boolean 把一半失败盖掉。
   */
  async hardDeleteMany(
    assetKeys: string[]
  ): Promise<{ deleted: string[]; failed: Array<{ assetKey: string; error: string }> }> {
    const res = await window.api.database.assetData.hardDeleteMany(assetKeys)
    return unwrapResult<{ deleted: string[]; failed: Array<{ assetKey: string; error: string }> }>(
      res,
      '批量彻底删除资产失败'
    )
  },
  /** 一次恢复一批，同样如实返回哪些没成 */
  async restoreMany(
    assetKeys: string[]
  ): Promise<{ restored: string[]; failed: Array<{ assetKey: string; error: string }> }> {
    const res = await window.api.database.assetData.restoreMany(assetKeys)
    return unwrapResult<{ restored: string[]; failed: Array<{ assetKey: string; error: string }> }>(
      res,
      '批量恢复资产失败'
    )
  },
  async restore(assetKey: string): Promise<{ restored: boolean }> {
    const res = await window.api.database.assetData.restore(assetKey)
    const ok = unwrapResult<boolean>(res, '恢复资产失败')
    return { restored: ok }
  },
  async moveToFolder(assetKey: string, newFolderKey: string): Promise<{ moved: boolean }> {
    const res = await window.api.database.assetData.moveToFolder(assetKey, newFolderKey)
    const ok = unwrapResult<boolean>(res, '移动资产失败')
    reportRemoteSync(res)
    return { moved: ok }
  },
  /**
   * 批量创建资产
   * @param assetsData 资产数据数组
   * @returns 返回成功创建的数量。主进程返回的是新建记录的自增ID数组，这里转换为数量以便调用方使用。
   */
  async batchCreate(assetsData: AssetData[]): Promise<{ created: number }> {
    const res = await window.api.database.assetData.batchCreate(assetsData)
    const ids = unwrapResult<number[]>(res, '批量创建资产失败')
    return { created: Array.isArray(ids) ? ids.length : 0 }
  },
  async batchDelete(assetKeys: string[]): Promise<{ deleted: number }> {
    const res = await window.api.database.assetData.batchDelete(assetKeys)
    return unwrapResult<{ deleted: number }>(res, '批量删除资产失败')
  },
  async clearDeleted(): Promise<{ cleared: boolean }> {
    const res = await window.api.database.assetData.clearDeleted()
    const ok = unwrapResult<boolean>(res, '清空回收站资产失败')
    return { cleared: ok }
  },
  async importFolderStructureWithMetadata(
    folderContents: any[],
    rootFolderPath: string,
    targetFolderKey?: string,
    importConcurrency?: number,
    taskId?: string,
    importOptions?: FolderImportOptions
  ): Promise<any> {
    // 并发数只认调用方传进来的那个（调用方按库类型算，见 AssetManagement/index.vue）。
    // 原先这里还会回落到 localStorage 里那个设置页写的全局值 —— 那个设置项已删除
    const effectiveImportConcurrency =
      Number.isFinite(importConcurrency) && (importConcurrency || 0) > 0
        ? Math.max(1, Math.floor(importConcurrency!))
        : undefined
    const res = await window.api.database.assetData.importFolderStructureWithMetadata(
      folderContents,
      rootFolderPath,
      targetFolderKey,
      effectiveImportConcurrency,
      taskId,
      importOptions
    )
    return unwrapResult<any>(res, '导入文件夹结构并处理元数据失败')
  },
  async processAssetMetadata(assetKey: string, filePath: string): Promise<any> {
    const res = await window.api.database.assetData.processAssetMetadata(assetKey, filePath)
    return unwrapResult<any>(res, '处理资产元数据失败')
  },
  async reimportAsset(assetKey: string): Promise<{ success: boolean; error?: string }> {
    const res = await window.api.asset.reimportAsset(assetKey)
    return res
  },
  /**
   * 工程整包上传：一个工程目录打成一个 zip 送到 HTTP 资产服务器。
   * 进度走 asset:folderImportStage / Progress / Completed / Error 事件，按 taskId 对应任务卡。
   */
  async uploadProjectArchive(
    sourcePath: string,
    targetFolderKey?: string | null,
    taskId?: string
  ): Promise<
    NonNullable<Awaited<ReturnType<typeof window.api.asset.uploadProjectArchive>>['data']>
  > {
    const res = await window.api.asset.uploadProjectArchive(sourcePath, targetFolderKey, taskId)
    // 失败时主进程也会带回 data（里面有 errorCode），但对调用方只有成功结果有用
    return unwrapResult(
      res as { success: boolean; data: NonNullable<typeof res.data>; error?: string },
      '工程整包上传失败'
    )
  },
  /** 取回工程整包：下载到 destDir，zip 自动解开；进度同样走文件夹导入那套事件 */
  async pullProjectArchive(params: {
    remotePath: string
    fileName: string
    destDir: string
    taskId?: string
  }): Promise<
    NonNullable<Awaited<ReturnType<typeof window.api.asset.pullProjectArchive>>['data']>
  > {
    const res = await window.api.asset.pullProjectArchive(params)
    return unwrapResult(
      res as { success: boolean; data: NonNullable<typeof res.data>; error?: string },
      '取回工程整包失败'
    )
  },
  async reimportFolder(folderKey: string): Promise<{
    success: boolean
    total?: number
    successCount?: number
    failed?: number
    error?: string
  }> {
    const res = await window.api.asset.reimportFolder(folderKey)
    return res
  }
}

export default assetDataAPI
