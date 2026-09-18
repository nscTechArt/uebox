import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { basename, extname } from 'path'

import { getVaultDatabase } from '../../index'
import {
  getAllAssetData,
  getAssetDataByKey,
  getAssetsBySoftPaths,
  type AssetData
} from '../../models/assetData'
import { AssetDependencyResolver } from '../../../utils/assetDependency/AssetDependencyResolver'
import { getAssetClassNameCn } from '../../../utils/assetClassUtils'
import { UnrealAssetProcessor } from '../../../utils/fileProcessor/UnrealAssetProcessor'
import { splitSoftPath, type AssetImportStatusSummary } from '../../../../shared/assetDependency'
import { buildImportStatusSummary, parseImports } from '../../../utils/assetDependency/importStatus'

/**
 * 找出「谁引用了这个 softPath」。
 *
 * imports 是 JSON 文本列，建不了索引，所以只能全表扫一遍再逐行 parse。
 * 调用方要清楚这是 O(全库) 的操作 —— 详情面板不该走这条路，只有依赖关系图
 * 这种用户主动打开的页面才值得付这个代价。
 */
function findReferencingAssets(
  allAssets: AssetData[],
  targetSoftPath: string,
  excludeAssetKey: string
): AssetData[] {
  if (!targetSoftPath) return []
  const result: AssetData[] = []
  for (const asset of allAssets) {
    if (asset.assetKey === excludeAssetKey || !asset.imports) continue
    if (parseImports(asset.imports).includes(targetSoftPath)) {
      result.push(asset)
    }
  }
  return result
}

export function registerAssetDependencyIPC(): void {
  ipcMain.handle('db:assetData:getAssetReferences', async (_, assetKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const currentAsset = getAssetDataByKey(db, assetKey)

      if (!currentAsset || !currentAsset.softPath) {
        return { success: true, data: [] }
      }

      return {
        success: true,
        data: findReferencingAssets(getAllAssetData(db), currentAsset.softPath, assetKey)
      }
    } catch (error) {
      console.error('查询资产引用失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 详情面板用的轻量接口：这个资产引用的每一条依赖，在不在当前保管库里。
   *
   * 只做一次带 idx_assetData_softPath 索引的批量查询，不全表扫、不碰磁盘 ——
   * 用户每点一个资产就会调一次，必须便宜。想进一步区分「库外可读」和
   * 「真的断了」得读文件，那个留给 getAssetDependencyGraph。
   */
  ipcMain.handle('db:assetData:getAssetImportStatus', async (_, assetKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const currentAsset = getAssetDataByKey(db, assetKey)

      const empty: AssetImportStatusSummary = { total: 0, unresolvedCount: 0, items: [] }
      if (!currentAsset) return { success: true, data: empty }

      const softPaths = parseImports(currentAsset.imports)
      if (softPaths.length === 0) return { success: true, data: empty }

      return {
        success: true,
        data: buildImportStatusSummary(softPaths, getAssetsBySoftPaths(db, softPaths))
      }
    } catch (error) {
      console.error('查询资产导入依赖状态失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetData:getAssetDependencyGraph', async (_, assetKey: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const currentAsset = getAssetDataByKey(db, assetKey)

      if (!currentAsset) {
        return { success: false, error: '资产不存在' }
      }

      // 节点只带语义字段（kind / className / softPath …）。颜色和「缺失的引用」
      // 这类文案归渲染层 —— 主进程既不知道主题也不知道界面语言。
      const nodes: any[] = []
      const edges: any[] = []
      const nodeMap = new Map<string, any>()

      const currentNode = {
        id: currentAsset.assetKey,
        label: currentAsset.assetName || currentAsset.name || '',
        kind: 'root',
        className: currentAsset.className,
        classNameCn: getAssetClassNameCn(currentAsset.className),
        softPath: currentAsset.softPath,
        imgLocalPath: currentAsset.imgLocalPath,
        customPoster: currentAsset.customPoster,
        assetKey: currentAsset.assetKey,
        folderKey: currentAsset.folderKey,
        level: 0,
        isRoot: true
      }
      nodes.push(currentNode)
      nodeMap.set(currentAsset.assetKey, currentNode)

      // 正向依赖：一次带索引的批量查询，不再把整张表捞进内存
      const softPaths = parseImports(currentAsset.imports)
      const importedAssets = softPaths.length > 0 ? getAssetsBySoftPaths(db, softPaths) : []
      const foundSoftPaths = new Set(
        importedAssets.map((asset) => asset.softPath).filter(Boolean) as string[]
      )
      const missingImports = softPaths.filter((softPath) => !foundSoftPaths.has(softPath))

      importedAssets.forEach((asset) => {
        const node = {
          id: asset.assetKey,
          label: asset.assetName || asset.name || '',
          kind: 'in-vault',
          className: asset.className,
          classNameCn: getAssetClassNameCn(asset.className),
          softPath: asset.softPath,
          imgLocalPath: asset.imgLocalPath,
          customPoster: asset.customPoster,
          assetKey: asset.assetKey,
          folderKey: asset.folderKey,
          level: 1,
          isMissing: false
        }
        nodes.push(node)
        nodeMap.set(asset.assetKey, node)

        edges.push({
          from: currentAsset.assetKey,
          to: asset.assetKey,
          kind: 'depends-on',
          arrows: 'to'
        })
      })

      // 库里没命中的，才去读盘确认是「库外真有」还是「引用断了」
      const realMissingImports: string[] = []
      if (missingImports.length > 0) {
        const resolver = new AssetDependencyResolver({})
        const processor = new UnrealAssetProcessor()
        const mainAssetPath = currentAsset.originPath || currentAsset.filePath || ''

        if (mainAssetPath && existsSync(mainAssetPath)) {
          for (const softPath of missingImports) {
            const realPath = await resolver.convertSoftPathToRealPath(
              currentAsset.softPath || '',
              softPath,
              mainAssetPath
            )

            if (realPath && existsSync(realPath)) {
              try {
                const fileMetadata = await processor.processFile(realPath)
                const metadata = fileMetadata.metadata || {}
                const assetName = metadata.name || basename(realPath, extname(realPath))
                const className = metadata.className || 'Unknown'
                const nodeId = `external_${softPath.replace(/[^a-zA-Z0-9]/g, '_')}`

                if (!nodeMap.has(nodeId)) {
                  const node = {
                    id: nodeId,
                    label: assetName,
                    kind: 'external',
                    className,
                    classNameCn: getAssetClassNameCn(className),
                    softPath,
                    imgLocalPath: undefined,
                    customPoster: undefined,
                    assetKey: nodeId,
                    level: 1,
                    isMissing: false,
                    isExternal: true
                  }
                  nodes.push(node)
                  nodeMap.set(nodeId, node)
                  edges.push({
                    from: currentAsset.assetKey,
                    to: nodeId,
                    kind: 'depends-on',
                    arrows: 'to',
                    dashes: true
                  })
                }
              } catch (error) {
                console.warn(`读取依赖文件失败: ${realPath}`, error)
                realMissingImports.push(softPath)
              }
            } else {
              realMissingImports.push(softPath)
            }
          }
        } else {
          realMissingImports.push(...missingImports)
        }
      }

      realMissingImports.forEach((softPath) => {
        const missingNodeId = `missing_${softPath.replace(/[^a-zA-Z0-9]/g, '_')}`
        if (nodeMap.has(missingNodeId)) {
          edges.push({
            from: currentAsset.assetKey,
            to: missingNodeId,
            kind: 'missing',
            arrows: 'to',
            dashes: true
          })
          return
        }

        // label 留空：断掉的引用叫什么、后面跟不跟 (?)，是渲染层的 i18n 决定的
        const node = {
          id: missingNodeId,
          label: splitSoftPath(softPath).name,
          kind: 'missing',
          className: undefined,
          classNameCn: undefined,
          softPath,
          imgLocalPath: undefined,
          customPoster: undefined,
          assetKey: undefined,
          level: 1,
          isMissing: true
        }
        nodes.push(node)
        nodeMap.set(missingNodeId, node)

        edges.push({
          from: currentAsset.assetKey,
          to: missingNodeId,
          kind: 'missing',
          arrows: 'to',
          dashes: true
        })
      })

      // 反向引用：没有索引，只能全表扫。这是这个接口最贵的一步。
      const referencingAssets = currentAsset.softPath
        ? findReferencingAssets(getAllAssetData(db), currentAsset.softPath, assetKey)
        : []

      referencingAssets.forEach((asset) => {
        const nodeId = asset.assetKey
        if (nodeMap.has(nodeId)) {
          edges.push({
            from: nodeId,
            to: currentAsset.assetKey,
            kind: 'referenced-by',
            arrows: 'to'
          })
          return
        }

        const node = {
          id: nodeId,
          label: asset.assetName || asset.name || '',
          kind: 'in-vault',
          className: asset.className,
          classNameCn: getAssetClassNameCn(asset.className),
          softPath: asset.softPath,
          imgLocalPath: asset.imgLocalPath,
          customPoster: asset.customPoster,
          assetKey: asset.assetKey,
          folderKey: asset.folderKey,
          level: -1,
          isMissing: false
        }
        nodes.push(node)
        nodeMap.set(nodeId, node)
        edges.push({
          from: nodeId,
          to: currentAsset.assetKey,
          kind: 'referenced-by',
          arrows: 'to'
        })
      })

      return {
        success: true,
        data: {
          nodes,
          edges
        }
      }
    } catch (error) {
      console.error('获取依赖关系图失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
