/**
 * 自动标签服务
 * 在资产导入时根据智能标签规则自动为资产添加标签
 */

import { getPublicDatabase, getVaultDatabase } from '../../sqliteDataBase'
import { createTag, getTagByName, type Tag } from '../../sqliteDataBase/models/tag'
import { addAssetTag } from '../../sqliteDataBase/models/assetTag'
import { computeSmartTags } from './smartTags'

// 标签缓存：tagName -> tagId（避免重复查询数据库）
const tagCache = new Map<string, number>()

/**
 * 确保标签存在（如果不存在则创建）
 * @param tagName 标签名称
 * @param color 标签颜色
 * @returns 标签ID
 */
function ensureTag(tagName: string, color?: string): number {
  // 先查缓存
  const cachedId = tagCache.get(tagName)
  if (cachedId !== undefined) {
    return cachedId
  }

  const publicDb = getPublicDatabase()

  // 查找是否已存在
  const existingTag = getTagByName(publicDb, tagName)
  if (existingTag?.id) {
    tagCache.set(tagName, existingTag.id)
    return existingTag.id
  }

  // 创建新标签
  const tagData: Tag = {
    name: tagName,
    color: color || '#888888',
    is_favorite: false
  }
  const newId = createTag(publicDb, tagData)
  tagCache.set(tagName, newId)

  console.log(`✨ [AutoTag] 创建智能标签: ${tagName} (ID: ${newId})`)
  return newId
}

/**
 * 自动为资产添加智能标签
 * @param assetKey 资产唯一标识
 * @param assetName 资产名称（用于规则匹配）
 */
export function autoTagAsset(assetKey: string, assetName: string): void {
  try {
    // 计算智能标签
    const matchedTags = computeSmartTags(assetName)

    if (matchedTags.length === 0) {
      return // 没有匹配的规则，跳过
    }

    const vaultDb = getVaultDatabase()

    for (const tagRule of matchedTags) {
      try {
        // 确保标签存在
        const tagId = ensureTag(tagRule.tag, tagRule.color)

        // 关联资产和标签
        addAssetTag(vaultDb, { assetKey, tagId })
        // console.log(`🏷️ [AutoTag] ${assetName} -> ${tagRule.tag}`)
      } catch {
        // 忽略重复关联的错误（INSERT OR IGNORE）
      }
    }

    console.log(
      `🏷️ [AutoTag] ${assetName} 已添加 ${matchedTags.length} 个智能标签: ${matchedTags.map((t) => t.tag).join(', ')}`
    )
  } catch (error) {
    console.warn(`[AutoTag] 自动标签失败 ${assetName}:`, error)
  }
}

/**
 * 批量自动标签
 * @param assets 资产列表 [{assetKey, assetName}]
 */
export function batchAutoTagAssets(assets: Array<{ assetKey: string; assetName: string }>): {
  processed: number
  tagged: number
} {
  let processed = 0
  let tagged = 0

  for (const asset of assets) {
    try {
      const matchedTags = computeSmartTags(asset.assetName)

      if (matchedTags.length > 0) {
        const vaultDb = getVaultDatabase()

        for (const tagRule of matchedTags) {
          try {
            const tagId = ensureTag(tagRule.tag, tagRule.color)
            addAssetTag(vaultDb, { assetKey: asset.assetKey, tagId })
          } catch {
            // 忽略重复关联的错误
          }
        }
        tagged++
      }
      processed++
    } catch {
      processed++
    }
  }

  console.log(`🏷️ [AutoTag] 批量处理完成: ${processed} 个资产, ${tagged} 个已添加标签`)
  return { processed, tagged }
}

/**
 * 清理标签缓存（当需要刷新时调用）
 */
export function clearTagCache(): void {
  tagCache.clear()
}

/**
 * 为插件资产添加版本标签
 * @param assetKey 资产唯一标识
 * @param pluginVersion 插件版本信息
 */
export function autoTagPluginVersion(
  assetKey: string,
  pluginVersion: { versionName?: string; engineVersion?: string }
): void {
  try {
    const vaultDb = getVaultDatabase()

    // 添加插件版本标签（如果有）
    if (pluginVersion.versionName) {
      const versionTagName = `v${pluginVersion.versionName}`
      try {
        const tagId = ensureTag(versionTagName, '#8B5CF6') // 紫色，表示版本
        addAssetTag(vaultDb, { assetKey, tagId })
        console.log(`🏷️ [AutoTag] 插件版本标签: ${versionTagName}`)
      } catch {
        // 忽略重复关联的错误
      }
    }

    // 添加引擎版本标签（如果有）
    if (pluginVersion.engineVersion) {
      // 简化引擎版本：5.3.0-0+++UE5+Release-5.3 -> UE5.3
      let engineTag = pluginVersion.engineVersion
      const versionMatch = engineTag.match(/(\d+\.\d+)/)
      if (versionMatch) {
        engineTag = `UE${versionMatch[1]}`
      }
      try {
        const tagId = ensureTag(engineTag, '#3B82F6') // 蓝色，表示引擎版本
        addAssetTag(vaultDb, { assetKey, tagId })
        console.log(`🏷️ [AutoTag] 引擎版本标签: ${engineTag}`)
      } catch {
        // 忽略重复关联的错误
      }
    }
  } catch (error) {
    console.warn(`[AutoTag] 添加插件版本标签失败:`, error)
  }
}
