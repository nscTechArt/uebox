/**
 * 创建文件夹工具
 * 支持批量创建嵌套文件夹结构供 Agent 使用
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { getAppWindows } from '../../../../appWindows'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import {
  createAssetFolder,
  getAssetFolderByKey,
  getAssetFolderByPath,
  getAllAssetFolders
} from '../../../../sqliteDataBase/models/assetFolder'

// ===== 边界限制常量 =====
const MAX_FOLDER_NAME_LENGTH = 20 // 文件夹名称最大长度（超出截取）
const MAX_NESTING_DEPTH = 10 // 最大嵌套层级（超出跳过）
const MAX_TOTAL_FOLDERS = 100 // 单次最多创建文件夹数量（超出跳过）
const INVALID_CHARS = /[\\/:*?"<>|]/g // 文件夹名称禁止的字符（自动移除）

/**
 * 智能处理文件夹名称，返回处理后的名称和警告
 */
function sanitizeFolderName(name: string, warnings: string[]): string {
  let result = name?.trim() || ''

  // 空名称：使用默认名
  if (!result) {
    result = '新文件夹'
    warnings.push('存在空名称的文件夹，已使用默认名"新文件夹"')
  }

  // 移除非法字符
  if (INVALID_CHARS.test(result)) {
    result = result.replace(INVALID_CHARS, '')
    warnings.push(`文件夹名称"${name}"包含非法字符，已自动移除`)
  }

  // 截取长度
  if (result.length > MAX_FOLDER_NAME_LENGTH) {
    warnings.push(`文件夹名称"${result}"过长，已截取为前${MAX_FOLDER_NAME_LENGTH}个字符`)
    result = result.substring(0, MAX_FOLDER_NAME_LENGTH)
  }

  return result || '新文件夹'
}

/**
 * 智能处理同级重名：自动添加后缀 _1, _2...
 */
function deduplicateNames(nodes: FolderNode[], warnings: string[]): void {
  const nameCount: Record<string, number> = {}
  for (const node of nodes) {
    if (nameCount[node.name]) {
      const newName = `${node.name}_${nameCount[node.name]}`
      warnings.push(`同级文件夹名称"${node.name}"重复，已自动重命名为"${newName}"`)
      node.name = newName
    }
    nameCount[node.name] = (nameCount[node.name] || 0) + 1
  }
}

/**
 * 智能处理所有节点，返回处理后的节点和警告
 */
function processNodes(
  nodes: FolderNode[],
  warnings: string[],
  depth = 1,
  count = { value: 0 },
  skippedByDepth = { value: 0 }
): FolderNode[] {
  // 深度超限：跳过当前层及以下
  if (depth > MAX_NESTING_DEPTH) {
    const skipCount = countAllNodes(nodes)
    skippedByDepth.value += skipCount
    return []
  }

  // 智能处理名称
  for (const node of nodes) {
    node.name = sanitizeFolderName(node.name, warnings)
  }

  // 处理同级重名
  deduplicateNames(nodes, warnings)

  const result: FolderNode[] = []
  for (const node of nodes) {
    count.value++
    if (count.value > MAX_TOTAL_FOLDERS) {
      warnings.push(`单次创建数量超过${MAX_TOTAL_FOLDERS}个，已跳过后续文件夹`)
      break
    }

    const processedNode: FolderNode = { name: node.name }
    if (node.children && node.children.length > 0) {
      processedNode.children = processNodes(
        node.children,
        warnings,
        depth + 1,
        count,
        skippedByDepth
      )
    }
    result.push(processedNode)
  }

  // 结束时添加深度警告
  if (depth === 1 && skippedByDepth.value > 0) {
    warnings.push(`嵌套层级超过${MAX_NESTING_DEPTH}层，已跳过${skippedByDepth.value}个深层文件夹`)
  }

  return result
}

/**
 * 统计节点总数
 */
function countAllNodes(nodes: FolderNode[]): number {
  return nodes.reduce((acc, n) => acc + 1 + (n.children ? countAllNodes(n.children) : 0), 0)
}
/**
 * 文件夹节点类型（递归结构）
 */
interface FolderNode {
  name: string
  children?: FolderNode[]
}

/**
 * 文件夹节点 Schema（显式 3 层嵌套，避免 z.lazy 导致 AI SDK 生成缺少 type 的 JSON Schema）
 */
const FolderNodeSchemaL3 = z.object({
  name: z.string().describe('文件夹名称')
})

const FolderNodeSchemaL2 = z.object({
  name: z.string().describe('文件夹名称'),
  children: z.array(FolderNodeSchemaL3).optional().describe('子文件夹列表（第3层）')
})

const FolderNodeSchema: z.ZodType<FolderNode> = z.object({
  name: z.string().describe('文件夹名称'),
  children: z.array(FolderNodeSchemaL2).optional().describe('子文件夹列表（可选，支持嵌套到第3层）')
}) as z.ZodType<FolderNode>

/**
 * 创建结果接口
 */
interface CreateResult {
  folderKey: string
  folderName: string
  fullPath: string
  children?: CreateResult[]
}

/**
 * 递归创建文件夹
 * @param db 数据库实例
 * @param parentKey 父文件夹 key
 * @param nodes 要创建的文件夹节点列表
 * @returns 创建结果列表
 */
function createFoldersRecursively(
  db: ReturnType<typeof getVaultDatabase>,
  parentKey: string | null,
  nodes: FolderNode[]
): CreateResult[] {
  const results: CreateResult[] = []

  for (const node of nodes) {
    const folderKey = uuidv4()

    // 获取父文件夹信息以构建路径
    let fullPath = `/${node.name}`
    if (parentKey) {
      const parentFolder = getAssetFolderByKey(db, parentKey)
      if (parentFolder?.fullPath) {
        fullPath = `${parentFolder.fullPath}/${node.name}`
      }
    }

    // 创建文件夹
    createAssetFolder(db, {
      folderKey,
      fatherKey: parentKey,
      folderName: node.name,
      type: 'folder'
    })

    const result: CreateResult = {
      folderKey,
      folderName: node.name,
      fullPath
    }

    // 递归创建子文件夹
    if (node.children && node.children.length > 0) {
      result.children = createFoldersRecursively(db, folderKey, node.children)
    }

    results.push(result)
  }

  return results
}

/**
 * 创建文件夹工具
 * @returns 创建文件夹工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createFoldersTool() {
  return defineV2Tool({
    description: `在资产库中批量创建文件夹结构。

【重要】：请尽量一次性传入完整的嵌套结构！单次最多支持 100 个文件夹。

【使用场景】：
- 用户需要创建一套文件夹分类体系（如 CG 开发、游戏资产、影视制作等）
- 用户需要在指定文件夹下创建子文件夹

【参数说明】：
- parentFolderKey: 父文件夹（支持文件夹名称、路径或 key，使用 "ALL" 表示根目录）
- folders: 要创建的文件夹数组，支持嵌套的 children 结构（一次性传入所有文件夹）

【示例】：创建 CG 开发文件夹结构
{
  "parentFolderKey": "ALL",
  "folders": [
    {
      "name": "角色",
      "children": [
        { "name": "主角" },
        { "name": "NPC" },
        { "name": "怪物" }
      ]
    },
    {
      "name": "场景",
      "children": [
        { "name": "室内" },
        { "name": "室外" },
        { "name": "自然环境" }
      ]
    }
  ]
}`,
    inputSchema: z.object({
      parentFolderKey: z.string().describe('父文件夹的 key。使用 "ALL" 表示在资产库根目录下创建。'),
      folders: z.array(FolderNodeSchema).describe('要创建的文件夹列表，支持嵌套结构。')
    }),
    execute: async (input) => {
      try {
        const { parentFolderKey, folders } = input

        if (!folders || folders.length === 0) {
          return {
            success: false,
            error: '必须提供至少一个文件夹'
          }
        }

        const db = getVaultDatabase()

        // 智能解析父文件夹：支持 folderKey、文件夹名称、或路径
        let resolvedParentKey: string | null = null
        const warnings: string[] = []

        // 预处理：trim 并处理空值
        const cleanedParentKey = parentFolderKey?.trim().replace(/^\/+|\/+$/g, '') || ''

        if (!cleanedParentKey || cleanedParentKey.toLowerCase() === 'all') {
          resolvedParentKey = 'ALL'
          if (!cleanedParentKey) {
            warnings.push('未指定父文件夹，默认在根目录(ALL)下创建')
          }
        } else {
          // 1. 尝试按 folderKey 查找
          let parentFolder = getAssetFolderByKey(db, cleanedParentKey)

          // 2. 尝试按完整路径查找（如 /ALL/角色）
          if (!parentFolder) {
            const pathToCheck = `/${cleanedParentKey}`
            parentFolder = getAssetFolderByPath(db, pathToCheck)
          }

          // 3. 尝试按名称模糊匹配
          if (!parentFolder) {
            const allFolders = getAllAssetFolders(db)
            const matches = allFolders.filter(
              (f) => f.folderName.toLowerCase() === cleanedParentKey.toLowerCase()
            )

            if (matches.length > 1) {
              // 多个同名文件夹，使用第一个并警告
              warnings.push(
                `存在${matches.length}个名为"${cleanedParentKey}"的文件夹，已使用第一个匹配：${matches[0].fullPath}`
              )
            }
            parentFolder = matches[0]
          }

          if (!parentFolder) {
            return {
              success: false,
              error: `找不到父文件夹: "${cleanedParentKey}"。请确认文件夹名称正确，或使用 "ALL" 在根目录创建。`
            }
          }
          resolvedParentKey = parentFolder.folderKey
        }

        // 智能处理：名称清理、深度限制、数量限制、重名处理
        const processedFolders = processNodes(folders, warnings)

        if (processedFolders.length === 0) {
          return {
            success: false,
            error: '处理后没有可创建的文件夹'
          }
        }

        // 递归创建文件夹
        const results = createFoldersRecursively(db, resolvedParentKey, processedFolders)

        // 统计创建数量
        const countFolders = (items: CreateResult[]): number => {
          return items.reduce((acc, item) => {
            return acc + 1 + (item.children ? countFolders(item.children) : 0)
          }, 0)
        }

        const totalCount = countFolders(results)

        // 通知前端刷新资产树
        const mainWindow = getAppWindows()[0]
        if (mainWindow) {
          mainWindow.webContents.send('asset-tree:refresh', {
            parentKey: resolvedParentKey,
            createdCount: totalCount
          })
        }

        // 构建返回消息
        let message = `成功创建 ${totalCount} 个文件夹`
        if (warnings.length > 0) {
          message += `\n\n【自动处理说明】：\n${warnings.map((w) => `- ${w}`).join('\n')}`
        }

        return {
          success: true,
          message,
          data: {
            totalCount,
            folders: results,
            warnings: warnings.length > 0 ? warnings : undefined
          }
        }
      } catch (error) {
        console.error('[createFoldersTool] 创建文件夹失败:', error)
        return {
          success: false,
          error: `创建文件夹失败: ${(error as Error).message}`
        }
      }
    }
  })
}
