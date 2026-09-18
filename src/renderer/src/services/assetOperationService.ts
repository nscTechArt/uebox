/**
 * 资产操作服务
 * 提供资产库搜索、标签、备注等操作能力
 * 提供搜索、标注、打标签、定位文件夹与保存资产的通用能力
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { v4 as uuidv4 } from 'uuid'
import { resolveErrorText } from '@renderer/views/AssetManagement/utils/assetVaultHelpers'

/**
 * 资产搜索参数
 */
export interface AssetSearchParams {
  /** 搜索关键词 */
  query?: string
  /** 文件格式（支持别名如"模型"、"贴图"） */
  fileFormat?: string | string[]
  /** 虚幻引擎资产类型 */
  assetType?: string | string[]
  /** 文件大小范围 */
  fileSize?: { min?: number; max?: number }
  /** 引擎版本 */
  engineVersion?: string | string[]
  /** 是否只搜索无标签资产 */
  hasNoTags?: boolean
  /** 返回数量限制 */
  limit?: number
}

/**
 * 资产搜索结果
 */
export interface AssetSearchResult {
  success: boolean
  assets: FormattedAsset[]
  total: number
  error?: string
  message?: string
}

/**
 * 格式化后的资产
 */
export interface FormattedAsset {
  assetKey: string
  assetName: string
  folderKey: string
  folderName?: string
  assetType?: string
  classNameCn?: string
  fileSize?: number
  fileExtension?: string
  note?: string
  imgLocalPath?: string
  customPoster?: string
  softPath?: string
  engineVersion?: string
}

/**
 * 添加备注参数
 */
export interface AddAssetNoteParams {
  assetKey: string
  note?: string
  tagNames?: string[]
}

/**
 * 添加备注结果
 */
export interface AddAssetNoteResult {
  success: boolean
  assetKey?: string
  note?: string
  addedTags?: Array<{ id: number; name: string }>
  error?: string
  message?: string
}

/**
 * 添加标签参数
 */
export interface AddAssetTagsParams {
  assetKey: string
  tagNames?: string[]
  tagIds?: number | number[]
}

/**
 * 添加标签结果
 */
export interface AddAssetTagsResult {
  success: boolean
  assetKey?: string
  addedTags?: Array<{ id: number; name: string }>
  existingTags?: Array<{ id: number; name: string }>
  failedTags?: Array<{ name: string; reason: string }>
  error?: string
  message?: string
}

/**
 * 跳转文件夹参数
 */
export interface JumpToFolderParams {
  folderKey: string
}

/**
 * 跳转文件夹结果
 */
export interface JumpToFolderResult {
  success: boolean
  error?: string
  message?: string
}

/**
 * 调用主进程的资产搜索
 * @param params 搜索参数
 * @returns 搜索结果
 */
export async function searchAssets(params: AssetSearchParams): Promise<AssetSearchResult> {
  console.log('[assetService] 搜索资产:', params)

  try {
    // 构建搜索条件
    const criteria: Record<string, unknown> = {}

    if (params.query) {
      criteria.keyword = params.query
    }

    if (params.hasNoTags !== undefined) {
      criteria.hasNoTags = params.hasNoTags
    }

    if (params.limit) {
      criteria.limit = params.limit
    }

    if (params.fileFormat) {
      const formats = Array.isArray(params.fileFormat) ? params.fileFormat : [params.fileFormat]
      criteria.fileExtensions = formats
    }

    if (params.assetType) {
      const types = Array.isArray(params.assetType) ? params.assetType : [params.assetType]
      criteria.assetTypes = types
    }

    if (params.fileSize) {
      criteria.sizeRange = params.fileSize
    }

    if (params.engineVersion) {
      const versions = Array.isArray(params.engineVersion)
        ? params.engineVersion
        : [params.engineVersion]
      criteria.engineVersions = versions
    }

    // 调用 IPC
    const res = await (window as any).api.database.assetSearch.search(criteria)

    if (res.success && Array.isArray(res.data)) {
      const assets: FormattedAsset[] = res.data.map((asset: Record<string, unknown>) => ({
        assetKey: asset.assetKey as string,
        assetName: asset.assetName as string,
        folderKey: asset.folderKey as string,
        folderName: asset.folderName as string | undefined,
        assetType: asset.assetType as string | undefined,
        classNameCn: asset.classNameCn as string | undefined,
        fileSize: (asset.fileSize ?? asset.size) as number | undefined,
        fileExtension: (asset.fileExtension ?? asset.ext) as string | undefined,
        note: asset.note as string | undefined,
        imgLocalPath: asset.imgLocalPath as string | undefined,
        softPath: asset.softPath as string | undefined,
        engineVersion: asset.engineVersion as string | undefined
      }))

      return {
        success: true,
        assets,
        total: assets.length
      }
    }

    return {
      success: false,
      assets: [],
      total: 0,
      error: res.error || '搜索失败'
    }
  } catch (error) {
    console.error('[assetService] 搜索资产失败:', error)
    return {
      success: false,
      assets: [],
      total: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 为资产添加备注
 * @param params 备注参数
 * @returns 操作结果
 */
export async function addAssetNote(params: AddAssetNoteParams): Promise<AddAssetNoteResult> {
  console.log('[assetService] 添加备注:', params)

  try {
    // 更新资产备注
    const updateRes = await (window as any).api.database.assetData.update(params.assetKey, {
      note: params.note || ''
    })

    if (!updateRes.success) {
      return {
        success: false,
        error: updateRes.error || '更新备注失败'
      }
    }

    const result: AddAssetNoteResult = {
      success: true,
      assetKey: params.assetKey,
      note: params.note,
      message: '已成功添加备注'
    }

    // 如果有标签，也添加标签
    if (params.tagNames && params.tagNames.length > 0) {
      const tagResult = await addAssetTags({
        assetKey: params.assetKey,
        tagNames: params.tagNames
      })
      if (tagResult.success && tagResult.addedTags) {
        result.addedTags = tagResult.addedTags
        result.message = `已成功添加备注和 ${tagResult.addedTags.length} 个标签`
      }
    }

    return result
  } catch (error) {
    console.error('[assetService] 添加备注失败:', error)
    return {
      success: false,
      error: resolveErrorText(error, '添加备注失败')
    }
  }
}

/**
 * 为资产添加标签
 * @param params 标签参数
 * @returns 操作结果
 */
export async function addAssetTags(params: AddAssetTagsParams): Promise<AddAssetTagsResult> {
  console.log('[assetService] 添加标签:', params)

  try {
    const addedTags: Array<{ id: number; name: string }> = []
    const existingTags: Array<{ id: number; name: string }> = []
    const failedTags: Array<{ name: string; reason: string }> = []

    // 获取当前资产的标签
    const currentTagsRes = await (window as any).api.database.assetTag.getTagIdsByAssetKey(
      params.assetKey
    )
    const currentTagIds = new Set(currentTagsRes.success ? currentTagsRes.data : [])

    // 处理标签名称
    if (params.tagNames && params.tagNames.length > 0) {
      for (const tagName of params.tagNames) {
        const trimmedName = tagName.trim()
        if (!trimmedName) continue

        try {
          // 查找或创建标签
          let tagRes = await (window as any).api.database.tag.getByName(trimmedName)

          if (!tagRes.success || !tagRes.data) {
            // 创建新标签
            tagRes = await (window as any).api.database.tag.create({ name: trimmedName })
          }

          if (tagRes.success && tagRes.data) {
            const tagId = tagRes.data.id
            const tagData = { id: tagId, name: trimmedName }

            if (currentTagIds.has(tagId)) {
              existingTags.push(tagData)
            } else {
              // 添加标签到资产
              const addRes = await (window as any).api.database.assetTag.add(params.assetKey, tagId)
              if (addRes.success) {
                addedTags.push(tagData)
              } else {
                failedTags.push({ name: trimmedName, reason: addRes.error || '添加失败' })
              }
            }
          }
        } catch (err) {
          failedTags.push({
            name: trimmedName,
            reason: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    // 处理标签 ID
    if (params.tagIds !== undefined) {
      const ids = Array.isArray(params.tagIds) ? params.tagIds : [params.tagIds]
      for (const tagId of ids) {
        try {
          // 获取标签信息
          const tagRes = await (window as any).api.database.tag.getById(tagId)
          if (!tagRes.success || !tagRes.data) {
            failedTags.push({ name: `ID:${tagId}`, reason: '标签不存在' })
            continue
          }

          const tagData = { id: tagId, name: tagRes.data.name }

          if (currentTagIds.has(tagId)) {
            existingTags.push(tagData)
          } else {
            const addRes = await (window as any).api.database.assetTag.add(params.assetKey, tagId)
            if (addRes.success) {
              addedTags.push(tagData)
            } else {
              failedTags.push({ name: tagRes.data.name, reason: addRes.error || '添加失败' })
            }
          }
        } catch (err) {
          failedTags.push({
            name: `ID:${tagId}`,
            reason: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    return {
      success: true,
      assetKey: params.assetKey,
      addedTags,
      existingTags,
      failedTags,
      message: `已添加 ${addedTags.length} 个标签`
    }
  } catch (error) {
    console.error('[assetService] 添加标签失败:', error)
    return {
      success: false,
      error: resolveErrorText(error, '添加标签失败')
    }
  }
}

/**
 * 跳转到资产所在文件夹
 * @param params 跳转参数
 * @returns 操作结果
 */
export async function jumpToFolder(params: JumpToFolderParams): Promise<JumpToFolderResult> {
  console.log('[assetService] 跳转文件夹:', params)

  try {
    // 发送跳转事件
    // 这里通过自定义事件通知前端进行跳转
    window.dispatchEvent(
      new CustomEvent('asset-folder:changed', {
        detail: { folderKey: params.folderKey }
      })
    )

    return {
      success: true,
      message: `已发送跳转指令（folderKey: ${params.folderKey}）`
    }
  } catch (error) {
    console.error('[assetService] 跳转文件夹失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 根据路径获取文件夹参数
 */
export interface GetFolderByPathParams {
  path: string
}

/**
 * 根据路径获取文件夹结果
 */
export interface GetFolderByPathResult {
  success: boolean
  data?: {
    id: number
    folderKey: string
    fatherKey?: string | null
    folderName: string
    fullPath?: string
    depth?: number
  }
  error?: string
}

/**
 * 根据路径获取文件夹
 * @param params 参数
 * @returns 结果
 */
export async function getFolderByPath(
  params: GetFolderByPathParams
): Promise<GetFolderByPathResult> {
  console.log('[assetService] 获取文件夹:', params)

  try {
    const res = await (window as any).api.database.assetFolder.getByPath(params.path)
    return {
      success: res.success,
      data: res.data,
      error: res.error
    }
  } catch (error) {
    console.error('[assetService] 获取文件夹失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 保存资产参数
 */
export interface SaveAssetParams {
  asset: FormattedAsset
}

/**
 * 保存资产结果
 */
export interface SaveAssetResult {
  success: boolean
  assetKey?: string
  message?: string
  error?: string
}

/**
 * 保存资产到数据库
 * @param params 保存参数
 * @returns 操作结果
 */
export async function saveAsset(params: SaveAssetParams): Promise<SaveAssetResult> {
  console.log('[assetService] 保存资产:', params)

  try {
    const { asset } = params
    // 构造数据库资产数据
    const assetData: any = {
      assetKey: asset.assetKey,
      folderKey: asset.folderKey,
      assetName: asset.assetName,
      imgLocalPath: asset.imgLocalPath,
      customPoster: asset.customPoster,
      filePath: asset.softPath || asset.imgLocalPath,
      fileSize: asset.fileSize,
      fileExtension: asset.fileExtension,
      assetType: asset.assetType,
      modifiedTime: new Date().toISOString(),
      note: asset.note
    }

    // 调用创建接口
    const res = await (window as any).api.database.assetData.create(assetData)

    if (res.success) {
      // 如果 Asset 对象中有 note，尝试保存 note
      if (asset.note) {
        await addAssetNote({
          assetKey: asset.assetKey,
          note: asset.note
        })
      }

      return {
        success: true,
        assetKey: asset.assetKey,
        message: '资产保存成功'
      }
    } else {
      return {
        success: false,
        error: res.error || '保存资产失败'
      }
    }
  } catch (error) {
    console.error('[assetService] 保存资产异常:', error)
    return {
      success: false,
      error: resolveErrorText(error, '保存资产失败')
    }
  }
}

/**
 * 下载图片并保存为资产
 */
export async function downloadAndSaveImageAsset(params: {
  imageUrl: string
  name: string
  format: string
  folderKey: string
}): Promise<{ success: boolean; asset?: FormattedAsset; error?: string }> {
  try {
    console.log('[assetService] 开始下载并保存图片资产:', params)

    // 1. 获取 Vault 路径
    const pathRes = await (window as any).api.invoke('vault:getCurrentPath')
    if (!pathRes.success) throw new Error(pathRes.error || '无法获取保管库路径')
    const vaultPath = pathRes.path

    // 2. 下载图片
    const response = await fetch(params.imageUrl)
    if (!response.ok) throw new Error(`下载失败: ${response.statusText}`)
    const blob = await response.blob()
    const arrayBuffer = await blob.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)

    // 3. 准备目标路径
    // 根据系统检测路径分隔符
    const isWindows = vaultPath.includes('\\')
    const sep = isWindows ? '\\' : '/'
    const assetDataDir = `${vaultPath}${sep}assetData`
    const fileName = `${params.name.replace(/[<>:"/\\|?*]/g, '_')}_${Date.now()}.${params.format}`
    const absoluteFilePath = `${assetDataDir}${sep}${fileName}`
    const relativeFilePath = `assetData${sep}${fileName}`

    // 4. 确保目录存在并写入文件
    await (window as any).api.invoke('fs:ensureDir', assetDataDir)
    const writeRes = await (window as any).api.invoke(
      'fs:writeFile',
      absoluteFilePath,
      Array.from(uint8Array)
    )
    if (!writeRes.success) throw new Error(writeRes.error || '写入文件失败')

    // 5. 保存到数据库
    const asset: FormattedAsset = {
      assetKey: uuidv4(),
      assetName: params.name,
      folderKey: params.folderKey,
      imgLocalPath: relativeFilePath,
      customPoster: relativeFilePath, // 使用相对路径作为封面，utils/thumbnails.ts 会自动处理
      assetType: 'Generated',
      fileSize: uint8Array.length,
      fileExtension: params.format,
      softPath: relativeFilePath
    }

    const saveRes = await saveAsset({ asset })
    if (!saveRes.success) throw new Error(saveRes.error || '数据库保存失败')

    // 通知 UI 刷新/跳转到该文件夹
    window.dispatchEvent(
      new CustomEvent('asset-folder:changed', {
        detail: { folderKey: asset.folderKey }
      })
    )

    return { success: true, asset }
  } catch (error) {
    console.error('[assetService] downloadAndSaveImageAsset failed:', error)
    return { success: false, error: resolveErrorText(error, '下载并保存图片资产失败') }
  }
}

/**
 * 保存拖拽进来的图片文件为资产。
 * 用于兜底：从网页拖拽图片时 Electron 拿不到本地文件路径（webUtils.getPathForFile 返回空），
 * 但拖拽自带的 File 对象本身有真实字节数据，直接读取写入资产库即可，无需依赖路径。
 */
export async function saveDroppedImageFileAsAsset(params: {
  file: File
  folderKey: string
}): Promise<{ success: boolean; asset?: FormattedAsset; error?: string }> {
  try {
    const pathRes = await (window as any).api.invoke('vault:getCurrentPath')
    if (!pathRes.success) throw new Error(pathRes.error || '无法获取保管库路径')
    const vaultPath = pathRes.path

    const arrayBuffer = await params.file.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)
    if (uint8Array.length === 0) throw new Error('拖拽的图片数据为空')

    const format =
      (params.file.type.split('/')[1] || params.file.name.split('.').pop() || 'png')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '') || 'png'
    const baseName = (params.file.name || '网页图片').replace(/\.[^.]+$/, '') || '网页图片'

    const isWindows = vaultPath.includes('\\')
    const sep = isWindows ? '\\' : '/'
    const assetDataDir = `${vaultPath}${sep}assetData`
    const fileName = `${baseName.replace(/[<>:"/\\|?*]/g, '_')}_${Date.now()}.${format}`
    const absoluteFilePath = `${assetDataDir}${sep}${fileName}`
    const relativeFilePath = `assetData${sep}${fileName}`

    await (window as any).api.invoke('fs:ensureDir', assetDataDir)
    const writeRes = await (window as any).api.invoke(
      'fs:writeFile',
      absoluteFilePath,
      Array.from(uint8Array)
    )
    if (!writeRes.success) throw new Error(writeRes.error || '写入文件失败')

    const asset: FormattedAsset = {
      assetKey: uuidv4(),
      assetName: baseName,
      folderKey: params.folderKey,
      imgLocalPath: relativeFilePath,
      customPoster: relativeFilePath,
      assetType: 'Generated',
      fileSize: uint8Array.length,
      fileExtension: format,
      softPath: relativeFilePath
    }

    const saveRes = await saveAsset({ asset })
    if (!saveRes.success) throw new Error(saveRes.error || '数据库保存失败')

    window.dispatchEvent(
      new CustomEvent('asset-folder:changed', {
        detail: { folderKey: asset.folderKey }
      })
    )

    return { success: true, asset }
  } catch (error) {
    console.error('[assetService] saveDroppedImageFileAsAsset failed:', error)
    return { success: false, error: resolveErrorText(error, '保存网页拖拽图片失败') }
  }
}
