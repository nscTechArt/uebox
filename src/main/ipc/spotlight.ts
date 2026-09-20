import { ipcMain } from 'electron'
import { getPublicDatabase } from '../sqliteDataBase'
import { getVaultDatabase } from '../sqliteDataBase/index'
import { searchProjects, ProjectRecord } from '../sqliteDataBase/models/project'
import { searchAssetDataByName, AssetData } from '../sqliteDataBase/models/assetData'
import { searchAssetsByCriteria } from '../sqliteDataBase/models/assetSearch'
import { resolveKeywordCriteria } from '../sqliteDataBase/models/assetSearchIndex'
import { logger } from '../services'
import type { SpotlightSearchResponse, SpotlightSearchResult } from '../../shared/spotlight'
import { mt } from '../i18n'

/**
 * 注册 Spotlight 搜索相关 IPC
 */
export function registerSpotlightIPC(): void {
  /**
   * 统一搜索接口
   * 返回项目、资产和 AI 对话结果
   */
  ipcMain.handle(
    'spotlight:search',
    async (_event, query: string): Promise<SpotlightSearchResponse> => {
      const results: SpotlightSearchResult[] = []
      const projectResults: SpotlightSearchResult[] = []
      const assetResults: SpotlightSearchResult[] = []
      const trimmedQuery = query.trim()

      if (!trimmedQuery) {
        return { success: true, data: results }
      }

      // 1. 搜索项目（最多显示 5 个）
      try {
        const db = getPublicDatabase()
        if (db) {
          const projects = searchProjects(db, trimmedQuery).slice(0, 5)
          for (const project of projects) {
            projectResults.push(formatProjectResult(project))
          }
        }
      } catch {
        // 项目数据库可能未初始化，忽略错误
        logger.debug('[Spotlight] 项目搜索跳过（数据库未初始化）')
      }

      // 2. 搜索资产（最多显示 5 个）
      try {
        const vaultDb = getVaultDatabase()
        if (vaultDb) {
          // 每敲一个字调一次。LIKE '%x%' 在 52 万行的库上 5 秒多且同步阻塞主进程，
          // 索引就绪就走 FTS；没就绪才退回 LIKE，并且只取 5 条。
          const keyword = resolveKeywordCriteria(vaultDb, trimmedQuery)
          const assets = keyword.ftsMatch
            ? // 这里没有任何筛选条件、不分页、也不数总数，截断召回是安全的：
              // 一个字母就是前缀词，不封顶的话 52 万行几乎全中，每敲一键算一遍 bm25
              searchAssetsByCriteria(vaultDb, {
                ftsMatch: keyword.ftsMatch,
                limit: 5,
                recallDepth: 200
              })
            : searchAssetDataByName(vaultDb, trimmedQuery, 5)
          for (const asset of assets) {
            assetResults.push(formatAssetResult(asset))
          }
        }
      } catch {
        // 资产库可能未初始化，忽略错误
        logger.debug('[Spotlight] 资产搜索跳过（库未初始化）')
      }

      // 按顺序组装结果：AI 对话优先，项目其次，资产最后
      // 1. AI 对话（总是显示在最前）
      results.push({
        id: `ai-${Date.now()}`,
        type: 'ai',
        title: mt('spotlight.askAi', { query: trimmedQuery }),
        description: mt('spotlight.askAiDesc'),
        icon: 'robot',
        data: { message: trimmedQuery }
      })

      // 2. 项目结果
      results.push(...projectResults)

      // 3. 资产结果
      results.push(...assetResults)

      logger.debug(`[Spotlight] 搜索 "${trimmedQuery}" 返回 ${results.length} 条结果`)

      return { success: true, data: results }
    }
  )
}

/**
 * 格式化项目搜索结果
 */
function formatProjectResult(project: ProjectRecord): SpotlightSearchResult {
  return {
    id: `project-${project.projectKey}`,
    type: 'project',
    title: project.projectName || '未命名项目',
    description: project.projectPath || project.originPath || undefined,
    icon: 'project',
    data: {
      projectKey: project.projectKey,
      projectPath: project.projectPath,
      originPath: project.originPath,
      engineAssociation: project.EngineAssociation
    }
  }
}

/**
 * 格式化资产搜索结果
 */
function formatAssetResult(asset: AssetData): SpotlightSearchResult {
  const extension = asset.fileExtension ? `.${asset.fileExtension}` : ''
  const assetName = asset.assetName?.trim() || '未命名资产'

  return {
    id: `asset-${asset.assetKey}`,
    type: 'asset',
    title: `${assetName}${extension}`,
    description: asset.filePath || asset.className || undefined,
    icon: getAssetIcon(asset.fileExtension),
    data: {
      assetKey: asset.assetKey,
      folderKey: asset.folderKey,
      filePath: asset.filePath,
      className: asset.className
    }
  }
}

/**
 * 根据文件扩展名获取图标
 */
function getAssetIcon(extension?: string): string {
  if (!extension) return 'file'

  const ext = extension.toLowerCase()

  // 3D 模型
  if (['fbx', 'obj', 'gltf', 'glb'].includes(ext)) return 'model'

  // 图片
  if (['png', 'jpg', 'jpeg', 'tga', 'psd', 'exr', 'hdr'].includes(ext)) return 'image'

  // 音频
  if (['wav', 'mp3', 'ogg'].includes(ext)) return 'audio'

  // 蓝图/脚本
  if (['umap', 'uasset'].includes(ext)) return 'package'

  return 'file'
}
