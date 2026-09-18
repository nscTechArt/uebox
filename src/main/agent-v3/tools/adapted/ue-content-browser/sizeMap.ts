/**
 * 一个资产连同它的依赖一共有多大 —— 编辑器 Size Map 的等价物。
 *
 * ## 为什么 ue_content_describe 答不了这个
 *
 * 那个给的是**一层**直接依赖：这个蓝图引用了哪 6 个资产。
 * 但「这个蓝图拖了多少东西进内存」的答案通常在第三层 ——
 * 蓝图引材质、材质引贴图、贴图是 8K。只看一层会得出「它很小」的结论。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { humanBytes } from './formatBytes'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const SizeMapSchema = z.object({
  path: z.string().describe('资产路径，如 /Game/Maps/MainLevel 或 /Game/Blueprints/BP_Player'),
  max_nodes: z
    .number()
    .optional()
    .describe('最多展开多少个包，默认 5000。展开不完会在结果里说明，不会悄悄截断')
})

interface Contributor {
  path: string
  class: string
  size: number
}

interface SizeMapResponse {
  ok?: boolean
  root?: string
  total_size?: number
  dependency_count?: number
  truncated?: boolean
  top_contributors?: Contributor[]
  note?: string
}

export function createSizeMapTool(): V2Tool {
  return defineV2Tool({
    description: `一个资产**连同它的全部依赖**一共占多大，以及是哪几个依赖占的。

【回答的问题】"这张关卡为什么这么大"、"这个蓝图拖了多少东西进来"、
"打包时这个角色会带走什么"。

【和 ue_content_describe 的区别】那个给一层直接依赖（引用了谁），
这个递归展开整条依赖链并把包体加起来。真正吃地方的常常在第三层。

【和 ue_project_asset_ranking 的区别】那个横着比（工程里谁最大），
这个竖着挖（一个东西背后拖了什么）。找到排行榜第一名之后用这个看它为什么大。

【参数】
- path: 资产路径。对象路径（/Game/A/B.B）和包名（/Game/A/B）都认
- max_nodes: 最多展开多少个包，默认 5000

【读结果时注意】
- 尺寸是磁盘上压缩过的编辑器包体，不是运行时内存。
- **引擎自带内容（/Engine/、/Script/）不计入** —— 用户既动不了也不该为它操心。
- \`truncated: true\` 表示依赖太多没展开完，报告里要说清楚是下限而不是总数。`,
    inputSchema: SizeMapSchema,
    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const response = await wsService.callRequest<SizeMapResponse>(
          'content.size_map',
          input,
          getTargetConnectionId(),
          120000
        )

        if (!response) {
          return { success: false, error: '服务未返回有效数据' }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failed = (response as any)?.ok === false || (response as any)?.success === false
        if (failed) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const code = (response as any)?.__rpc?.code ?? (response as any)?.code
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = (response as any)?.error || (response as any)?.message || '依赖体积统计失败'
          return {
            success: false,
            error:
              code === 404
                ? `找不到这个资产：${input.path}。先用 ue_content_search 确认路径。`
                : `依赖体积统计失败：${msg}`,
            code
          }
        }

        const total = response.total_size ?? 0
        const contributors = (response.top_contributors ?? []).map((c) => ({
          ...c,
          size_human: humanBytes(c.size),
          share: total > 0 ? Math.round((c.size / total) * 100) : 0
        }))

        return {
          success: true,
          root: response.root,
          total_size: total,
          total_size_human: humanBytes(total),
          dependency_count: response.dependency_count,
          truncated: response.truncated,
          top_contributors: contributors,
          note: response.note,
          summary:
            `${response.root} 连同 ${response.dependency_count ?? 0} 个依赖共 ${humanBytes(total)}` +
            (contributors[0]
              ? `，最大的一个是 ${contributors[0].path}（${contributors[0].size_human}，占 ${contributors[0].share}%）`
              : '') +
            (response.truncated ? '。依赖太多没展开完，这个数是下限' : '')
        }
      } catch (error) {
        console.error('[SizeMapTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
