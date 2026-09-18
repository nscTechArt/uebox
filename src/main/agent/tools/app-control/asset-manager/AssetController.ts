// 资产控制器 - 处理资产的备注、标签、跳转等操作
import { WebContents } from 'electron'
import { getVaultDatabase, getPublicDatabase } from '../../../../sqliteDataBase'
import { getAssetDataByKey, updateAssetData } from '../../../../sqliteDataBase/models/assetData'
import { getAssetFolderByKey } from '../../../../sqliteDataBase/models/assetFolder'
import { getTagByName, createTag } from '../../../../sqliteDataBase/models/tag'
import { getTagIdsByAssetKey, setTagsForAsset } from '../../../../sqliteDataBase/models/assetTag'
import type { AppControlResult } from '../types'
import type { AssetNoteParams, AssetTagsParams, JumpToFolderParams } from './types'

/**
 * 为资产添加/更新备注
 */
export async function addAssetNote(params: AssetNoteParams): Promise<AppControlResult> {
  const { assetKey, note, tagNames } = params
  const vaultDb = getVaultDatabase()
  const publicDb = getPublicDatabase()

  // 验证资产是否存在
  try {
    const asset = getAssetDataByKey(vaultDb, assetKey)
    if (!asset) {
      return {
        success: false,
        error: `资产不存在或已被删除（assetKey: ${assetKey}）`
      }
    }
  } catch (err) {
    console.error('验证资产失败:', err)
    return {
      success: false,
      error: `无法验证资产权限: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // 处理标签（如果提供了 tagNames）
  let tagResult: { addedCount: number; message: string } | null = null
  if (tagNames !== undefined && Array.isArray(tagNames) && tagNames.length > 0) {
    try {
      const resolvedTagIds: number[] = []

      // 遍历每个标签名称，查找或创建标签
      for (const tagName of tagNames) {
        if (!tagName || typeof tagName !== 'string' || tagName.trim() === '') {
          continue
        }

        const trimmedName = tagName.trim()

        try {
          // 先尝试查找现有标签
          const tag = getTagByName(publicDb, trimmedName)
          let tagId: number | undefined

          if (tag && typeof tag.id === 'number') {
            // 标签已存在，使用现有ID
            tagId = tag.id
          } else {
            // 标签不存在，创建新标签
            tagId = createTag(publicDb, {
              name: trimmedName
            })
          }

          if (tagId) {
            resolvedTagIds.push(tagId)
          }
        } catch (err) {
          console.error(`处理标签 "${trimmedName}" 失败:`, err)
          continue
        }
      }

      if (resolvedTagIds.length > 0) {
        // 获取资产当前的标签，合并而不是替换
        const currentTagIds = getTagIdsByAssetKey(vaultDb, assetKey)
        const mergedTagIds = Array.from(new Set([...currentTagIds, ...resolvedTagIds]))
        setTagsForAsset(vaultDb, assetKey, mergedTagIds)
        const addedCount = resolvedTagIds.filter((id) => !currentTagIds.includes(id)).length
        tagResult = {
          addedCount,
          message: addedCount > 0 ? `已添加 ${addedCount} 个标签` : '标签已存在'
        }
      }
    } catch (error) {
      console.error('处理标签失败:', error)
      // 标签处理失败不影响备注的保存
    }
  }

  // 更新资产备注
  try {
    const success = updateAssetData(vaultDb, assetKey, {
      note: String(note || '')
    })

    if (success) {
      const messages: string[] = ['已成功为资产添加备注']
      if (tagResult) {
        messages.push(tagResult.message)
      }
      return {
        success: true,
        count: 1,
        message: `${messages.join('，')}（assetKey: ${assetKey}）`
      }
    } else {
      return {
        success: false,
        error: '更新备注失败'
      }
    }
  } catch (error) {
    console.error('更新资产备注失败:', error)
    return {
      success: false,
      error: `更新资产备注失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 为资产添加标签（名称或 ID）
 */
export async function addAssetTags(params: AssetTagsParams): Promise<AppControlResult> {
  const { assetKey, tagNames, tagIds } = params
  const vaultDb = getVaultDatabase()
  const publicDb = getPublicDatabase()

  // 验证资产是否存在
  try {
    const asset = getAssetDataByKey(vaultDb, assetKey)
    if (!asset) {
      return {
        success: false,
        error: `资产不存在或已被删除（assetKey: ${assetKey}）`
      }
    }
  } catch (err) {
    console.error('验证资产失败:', err)
    return {
      success: false,
      error: `无法验证资产权限: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  let finalTagIds: number[] = []

  // 优先使用 tagNames，如果提供了 tagNames
  if (tagNames !== undefined) {
    // 处理 tagNames：可能是数组、字符串或 JSON 字符串
    let names: string[] = []

    if (Array.isArray(tagNames)) {
      // 已经是数组，直接使用
      names = tagNames.filter((n) => typeof n === 'string')
    } else if (typeof tagNames === 'string') {
      // 检查是否是 JSON 字符串（数组格式）
      const trimmed = tagNames.trim()
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          // 尝试解析 JSON 字符串
          const parsed = JSON.parse(trimmed)
          if (Array.isArray(parsed)) {
            names = parsed.filter((n) => typeof n === 'string')
            console.log('[AssetController] 解析 JSON 字符串为数组:', names)
          } else {
            // 解析后不是数组，当作单个字符串
            names = [trimmed]
          }
        } catch {
          // JSON 解析失败，当作单个字符串
          console.warn('[AssetController] JSON 解析失败，当作单个标签:', trimmed)
          names = [trimmed]
        }
      } else {
        // 普通字符串，当作单个标签
        names = [trimmed]
      }
    } else {
      // 其他类型，转换为字符串数组
      names = [String(tagNames)]
    }

    const resolvedTagIds: number[] = []

    // 遍历每个标签名称，查找或创建标签
    for (const tagName of names) {
      if (!tagName || typeof tagName !== 'string' || tagName.trim() === '') {
        continue
      }

      const trimmedName = tagName.trim()

      try {
        // 先尝试查找现有标签
        const tag = getTagByName(publicDb, trimmedName)
        let tagId: number | undefined

        if (tag && typeof tag.id === 'number') {
          // 标签已存在，使用现有ID
          tagId = tag.id
        } else {
          // 标签不存在，创建新标签
          tagId = createTag(publicDb, {
            name: trimmedName
          })
        }

        if (tagId) {
          resolvedTagIds.push(tagId)
        }
      } catch (err) {
        console.error(`处理标签 "${trimmedName}" 失败:`, err)
        continue
      }
    }

    finalTagIds = resolvedTagIds
  } else if (tagIds !== undefined) {
    // 使用提供的 tagIds
    finalTagIds = Array.isArray(tagIds)
      ? tagIds.filter((id) => typeof id === 'number' && Number.isFinite(id))
      : [tagIds].filter((id) => typeof id === 'number' && Number.isFinite(id))
  } else {
    return {
      success: false,
      error: '必须提供 tagNames 或 tagIds 参数之一'
    }
  }

  if (finalTagIds.length === 0) {
    return {
      success: false,
      error: '没有有效的标签可以添加'
    }
  }

  // 获取资产当前的标签，合并而不是替换
  try {
    const currentTagIds = getTagIdsByAssetKey(vaultDb, assetKey)

    // 合并标签ID，去重
    const mergedTagIds = Array.from(new Set([...currentTagIds, ...finalTagIds]))

    // 设置标签
    setTagsForAsset(vaultDb, assetKey, mergedTagIds)

    const addedCount = finalTagIds.filter((id) => !currentTagIds.includes(id)).length
    return {
      success: true,
      count: addedCount,
      message: `已成功为资产添加 ${addedCount} 个标签（assetKey: ${assetKey}）`,
      tagIds: mergedTagIds
    }
  } catch (error) {
    console.error('设置资产标签失败:', error)
    return {
      success: false,
      error: `设置标签失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 跳转到资产所在文件夹（通过 Electron IPC）
 */
export async function jumpToAssetFolder(
  params: JumpToFolderParams,
  sender: WebContents
): Promise<AppControlResult> {
  const { folderKey } = params

  // 验证文件夹是否存在
  try {
    const db = getVaultDatabase()
    const folder = getAssetFolderByKey(db, folderKey)
    if (!folder) {
      return {
        success: false,
        error: `文件夹不存在或已被删除（folderKey: ${folderKey}）`
      }
    }
  } catch (err) {
    console.error('验证文件夹失败:', err)
    return {
      success: false,
      error: `无法验证文件夹信息: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // 发送 IPC 消息给前端进行跳转
  try {
    sender.send('agent:action:jump', { folderKey })

    return {
      success: true,
      count: 1,
      message: `已发送跳转指令（folderKey: ${folderKey}）`
    }
  } catch (error) {
    console.error('发送跳转指令失败:', error)
    return {
      success: false,
      error: `发送跳转指令失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
