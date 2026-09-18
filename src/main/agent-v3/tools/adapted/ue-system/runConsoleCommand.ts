/**
 * 执行控制台指令工具
 * 通过 WebSocket 向虚幻引擎插件发送 system.run_console_command 命令
 * 在当前 World 上执行任意控制台指令
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 执行控制台指令请求参数
 */
const RunConsoleCommandParamsSchema = z.object({
  command: z.string().describe('要执行的控制台指令，如 "stat fps"、"r.SetRes 1920x1080" 等')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 执行控制台指令响应数据 */
interface RunConsoleCommandResponse {
  result: 'OK' | 'Failed'
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建执行控制台指令工具
 * @returns 执行控制台指令工具实例
 */
export function createRunConsoleCommandTool(): V2Tool {
  return defineV2Tool({
    description: `在虚幻引擎中执行控制台指令。

【功能说明】：
- 支持执行任意虚幻引擎控制台指令
- 支持 Editor/PIE/Standalone 模式
- 内部会根据是否有 GEditor 自动选择世界

【常用指令示例】：
- stat fps：显示 FPS 统计
- stat unit：显示单位时间统计
- stat scenerendering：场景渲染统计
- r.SetRes 1920x1080：设置分辨率
- HighResShot 2：截取高分辨率截图（**要看画面别用这条，用 ue_screenshot** ——
  HighResShot 只把图写到磁盘上，你看不到它；ue_screenshot 才会把画面回给你）
- ShowFlag.Lighting 0/1：切换光照显示

【注意事项】：
- 只读指令（如 stat 类）可直接使用
- 修改型指令需谨慎，确保在当前模式下有效`,

    inputSchema: RunConsoleCommandParamsSchema,

    execute: async (input) => {
      console.log('[RunConsoleCommandTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        console.log('[RunConsoleCommandTool] 发送 system.run_console_command 请求:', {
          command: input.command
        })

        const response = await wsService.callRequest<RunConsoleCommandResponse>(
          'system.run_console_command',
          { command: input.command },
          getTargetConnectionId(),
          30000
        )

        console.log('[RunConsoleCommandTool] 收到响应:', response)

        if (response) {
          // RPC 错误/失败透传
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          const isSuccess = response.result === 'OK'

          if (rpcOk === false || rpcSuccess === false || !isSuccess) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '执行失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return {
              success: false,
              result: response.result,
              error: `控制台指令执行失败：${msg}`,
              code,
              details,
              raw: response
            }
          }

          // 引擎侧现在会把命令的文字输出一并带回。不透传的话，
          // 查询类命令（cvar 当前值、stat、obj list）等于白跑 ——
          // 调用方能执行却看不到结果。
          const output = (response as { output?: string }).output
          const outputNote = (response as { output_note?: string }).output_note
          const truncated = (response as { output_truncated_chars?: number }).output_truncated_chars

          return {
            success: true,
            result: response.result,
            output,
            message:
              `控制台指令 "${input.command}" 执行成功` +
              (output
                ? `
输出：
${output}` +
                  (truncated
                    ? `
（前 ${truncated} 个字符已截断）`
                    : '')
                : outputNote
                  ? `
${outputNote}`
                  : '')
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[RunConsoleCommandTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
