/**
 * 删除资产工具
 * 通过 WebSocket 向虚幻引擎插件发送 content.delete 命令
 * 彻底删除资产或文件夹
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { toPackagePath } from '../../../core/assetLock'
import { releaseProtectionBeforeDelete } from '../../../core/assetLockEnforcement'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 删除资产请求参数
 */
const DeleteAssetsSchema = z.object({
  paths: z.array(z.string()).describe(
    // 原文写着「支持 Folder 路径」，但引擎侧的 content.delete **没有文件夹分支** ——
    // 传目录一律失败，而且错误只说「无响应或 ok=false」，看不出是不支持文件夹。
    // 真机验证时踩到的：描述承诺了插件没有的能力，模型照着做必定失败。
    '要删除的**资产**路径列表，如 ["/Game/Temp/TestActor.TestActor"]。' +
      '只接受具体资产，不支持整个文件夹 —— 要清空目录请先用 ue_content_search 列出资产再逐个删。'
  ),
  drop_agent_undo: z
    .boolean()
    .optional()
    .describe(
      '丢掉你自己那几步撤销记录，好让这个资产删得动。**默认 false，只有用户明确同意了才填 true。**' +
        '刚被你改过的资产会被你自己的撤销栈拽着，引擎会判成「正在使用中」而拒绝删除；' +
        '这时先别重试，把失败原因里说的「要丢几步撤销」告诉用户，等他同意再带 true 调一次。' +
        '丢掉的只有**你**的撤销步骤，用户在编辑器里的撤销历史一步不动。'
    )
})

// ============================================================================
// 类型定义
// ============================================================================

/** 删除资产响应数据 (UE 插件返回) */
interface DeleteAssetsResponse {
  ok: boolean
  deleted_count: number
  requested_count: number
  deleted: string[]
  /** 每条失败的路径和**查出来的**原因（只读位 / agent 撤销栈 / 具体引用者） */
  failed?: Array<{ path: string; reason?: string }>
  /** 这次为了删成而丢掉的 agent 撤销步骤标题 */
  dropped_agent_undo_steps?: string[]
  error?: string
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建删除资产工具
 * @returns 删除资产工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createDeleteAssetsTool() {
  return defineV2Tool({
    description: `删除虚幻引擎项目中的资产（彻底删除，不可逆；支持批量）。

【警告】删除不可逆，删之前和用户核对清单。

【删不掉时**先读 reason，不要重试**】每条失败都带查出来的真原因，三类各有各的做法：
- **「this agent's own undo history」**：你自己刚才改过它，撤销记录攥着它。
  **别换 Python、别重试** —— 同一堵墙。把「要丢掉几步撤销」告诉用户，
  他同意了再带 drop_agent_undo=true 调一次（只丢你的撤销，用户的撤销历史不动）。
- **「read-only on disk」**：包文件只读。版本控制管着就让用户签出；
  另一条会话的资产锁就等它结束；用户自己设的就让用户解除。
- **「still referenced by: …」**：真被列出来的那些东西引用着。先处理引用方
  （删掉引用它的 Actor、改掉引用它的资产），或者告诉用户删不了。

【参数】paths（必填，只接受具体资产，不接受文件夹）、drop_agent_undo（见上，默认 false）。

【返回】ok、deleted_count（按路径算）、deleted、failed:[{path, reason}]、
dropped_agent_undo_steps（这次丢掉的撤销步骤标题，**有的话必须转述给用户**）。`,

    inputSchema: DeleteAssetsSchema,

    execute: async (input) => {
      console.log('[DeleteAssetsTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 构建请求参数
        const params = {
          paths: input.paths,
          drop_agent_undo: input.drop_agent_undo === true
        }

        console.log('[DeleteAssetsTool] 发送 content.delete 请求:', params)

        const connectionId = getTargetConnectionId()

        // 只读的包引擎删不掉且不报错（实测），而那个位可能正是盒子自己翻的。
        // 资产马上就没了，先把自己那份保护撤掉 —— 别让我们自己的锁把自己挡在门外
        await releaseProtectionBeforeDelete(connectionId, input.paths.map(toPackagePath))

        const response = await wsService.callRequest<DeleteAssetsResponse>(
          'content.delete',
          params,
          connectionId,
          30000
        )

        console.log('[DeleteAssetsTool] 收到响应:', response ? '成功' : '无数据')

        if (response && response.ok) {
          const result: Record<string, unknown> = {
            success: true,
            deleted_count: response.deleted_count,
            requested_count: response.requested_count,
            deleted: response.deleted,
            message: `已删除 ${response.deleted_count}/${response.requested_count} 个资产`
          }

          if (response.failed && response.failed.length > 0) {
            result.failed = response.failed
            result.message = `已删除 ${response.deleted_count}/${response.requested_count} 个资产，${response.failed.length} 个失败`
          }

          // 丢掉的撤销步骤要顶到消息里，不能只躺在字段里等模型自己去翻 ——
          // 那是用户真金白银损失的东西，必须被转述出去
          const dropped = response.dropped_agent_undo_steps
          if (dropped && dropped.length > 0) {
            result.dropped_agent_undo_steps = dropped
            result.message =
              `${result.message}。为此丢掉了你自己的 ${dropped.length} 步撤销记录` +
              `（${dropped.join('、')}），这几步再也撤不回来了，请在回复里告诉用户`
          }

          return result
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details
        return {
          success: false,
          error: `删除资产失败：${msg}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[DeleteAssetsTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
