/**
 * 搜索资产工具
 * 通过 WebSocket 向虚幻引擎插件发送 content.search 命令
 * 在 Content Browser 中查找匹配的资产路径
 *
 * 增强功能：
 * - 支持通配符查询（query 可选，默认 "*" 列出所有资产）
 * - 支持目录路径限制（path 参数）
 * - 支持返回文件夹结构（include_folders 参数）
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 搜索资产请求参数
 * query 可选，默认为 "*" 表示列出所有资产
 */
const SearchAssetsSchema = z.object({
  query: z
    .string()
    .optional()
    .default('*')
    .describe('搜索关键词，支持模糊匹配。使用 "*" 或留空可列出所有资产'),
  path: z
    .string()
    .optional()
    .describe('可选的目录路径限制，如 /Game/Blueprints 只搜索该目录下的资产'),
  filter_class: z
    .string()
    .optional()
    .describe('可选的类型过滤，如 Material, Texture2D, StaticMesh, Blueprint'),
  include_folders: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否在结果中包含文件夹信息，用于浏览目录结构'),
  limit: z.number().optional().default(100).describe('返回结果数量限制，默认 100，最大 500')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 搜索结果项 */
interface SearchResultItem {
  name: string
  path: string
  class: string
}

/** 搜索资产响应数据 (UE 插件返回) */
interface SearchAssetsResponse {
  ok: boolean
  /** 这次**返回**了几条（受 limit 限制） */
  count: number
  /** 真实匹配了几条（不受 limit 限制） */
  total?: number
  truncated?: boolean
  searched_path?: string
  results: SearchResultItem[]
  folders?: string[]
  folder_count?: number
  /** 目录 → 该目录下的资产数，按全量统计 */
  folder_counts?: Record<string, number>
  note?: string
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建搜索资产工具
 * @returns 搜索资产工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSearchAssetsTool() {
  return defineV2Tool({
    description: `在**当前打开的虚幻工程**的 Content Browser 中搜索资产（/Game/... 这些），
也可用于浏览项目目录结构。

【搜的是工程，不是素材库】这里只有已经在这个工程里的资产。用户说"找个木头材质""库里有没有"
这种**还没进工程**的素材，用 search_assets（盒子的素材库）；问"库里有什么"用 library_overview。
找关卡里摆着的实例用 ue_get_actor —— 那是场景里的 Actor，不是资产文件。

【功能说明】：
- 支持模糊匹配资产名称或路径
- 可按资产类型过滤
- 支持通配符搜索（使用 "*" 列出所有资产）
- 支持目录路径限制（只搜索指定目录）
- 返回资产的名称、路径和类型

【参数说明】：
- query: 搜索关键词（可选，默认 "*" 列出所有）
- path: 目录路径限制，如 /Game/Blueprints
- filter_class: 类型过滤，如 Material, Texture2D, StaticMesh, Blueprint
- include_folders: 是否返回文件夹信息
- limit: 返回数量限制（默认 100）

【盘点一个工程，第一步用这个】：
{ query: "*", include_folders: true, limit: 1 }
→ 回一份**全量**的目录清单和每个目录装了多少个资产（total 是真实总数）。
目录统计不受 limit 影响，所以一次调用就能看清工程长什么样，再按目录深入。

【别把返回条数当成全部】：count 是这次返回了几条（受 limit 限制），
total 才是真实匹配数，truncated=true 就是被截断了。
只看 count 会漏掉大半个工程 —— 这是真实发生过的事故。

【其他用法】：
1. 列出所有蓝图：{ query: "*", filter_class: "Blueprint" }
2. 列出指定目录：{ path: "/Game/Characters", query: "*" }
3. 搜插件内容：path 支持任何挂载点（/Game、/Engine、/<插件名>），不再只限 /Game

【返回数据】：
- count / total / truncated: 返回了几条 / 一共匹配几条 / 是否被截断
- results: 匹配的资产列表（包含 name, path, class）
- folders: include_folders=true 时，每个目录及其资产数`,

    inputSchema: SearchAssetsSchema,

    execute: async (input) => {
      console.log('[SearchAssetsTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 构建请求参数
        const params: Record<string, unknown> = {
          query: input.query || '*' // 默认通配符
        }
        // 添加可选参数
        if (input.path) params.path = input.path
        if (input.filter_class) params.filter_class = input.filter_class
        if (input.include_folders) params.include_folders = input.include_folders
        if (input.limit) params.limit = Math.min(input.limit, 500) // 限制最大 500

        console.log('[SearchAssetsTool] 发送 content.search 请求:', params)

        const response = await wsService.callRequest<SearchAssetsResponse>(
          'content.search',
          params,
          getTargetConnectionId(),
          15000
        )

        console.log('[SearchAssetsTool] 收到响应:', response ? '成功' : '无数据')

        if (response && response.ok) {
          /**
           * 截断必须说出来。
           *
           * 老版本只回「找到 N 个匹配的资产」，而 N 是**返回条数**不是匹配数 ——
           * 拿 limit=200 盘点工程的调用方会把前 200 条当成全部。2026-09-09 真机上
           * 就是这么漏掉了 /Game/LakeVilla（164 个，工程主内容）和 /Game/EasyFog。
           */
          const total = response.total ?? response.count
          const truncated = response.truncated ?? false
          const folderCounts = response.folder_counts
          const folderLines =
            folderCounts && Object.keys(folderCounts).length > 0
              ? Object.entries(folderCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([folder, count]) => `${folder}（${count} 个）`)
              : []

          const message = truncated
            ? `匹配 ${total} 个，只返回了前 ${response.count} 个 —— 这不是全部。` +
              '要全量：把 limit 调大（最大 500），或者用 path 按目录分片查；' +
              '只想知道哪些目录装了多少，用 include_folders=true，目录统计不受 limit 影响。'
            : `找到 ${total} 个匹配的资产（这就是全部）。`

          return {
            success: true,
            count: response.count,
            total,
            truncated,
            results: response.results,
            ...(folderLines.length > 0
              ? { folders: folderLines, folder_count: folderLines.length }
              : {}),
            message:
              message +
              (folderLines.length > 0
                ? `\n按目录（共 ${folderLines.length} 个，按资产数排）：\n- ${folderLines.join('\n- ')}`
                : '') +
              (response.note ? `\n${response.note}` : '')
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details
        return {
          success: false,
          error: `搜索资产失败：${msg}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[SearchAssetsTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
