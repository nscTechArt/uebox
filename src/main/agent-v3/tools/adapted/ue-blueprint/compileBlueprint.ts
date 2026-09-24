/**
 * Compile a Blueprint through the Unreal websocket bridge.
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { resolveBlueprintPathInput } from './resolveBlueprintPath'

const CompileBlueprintSchema = z.object({
  blueprint_path: z
    .string()
    .describe('Required Blueprint path, for example /Game/Blueprints/BP_Hero'),
  save: z.boolean().optional().default(true).describe('Whether to save after a successful compile.')
})

interface CompileBlueprintResponse {
  ok: boolean
  status: string
  saved: boolean
  path: string
  diagnostics?: Array<{
    type: 'Error' | 'Warning' | 'Info' | 'Other'
    message: string
    node_id?: string
    pin?: string
  }>
  [key: string]: unknown
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createCompileBlueprintTool() {
  return defineV2Tool({
    description: `Compile a Blueprint and optionally save it.

Use this after meaningful Blueprint graph or structure changes to validate the result.`,
    inputSchema: CompileBlueprintSchema,
    execute: async (input) => {
      console.log('[CompileBlueprintTool] Received request:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error:
              'No Unreal Editor connection is available. Start Unreal Editor and ensure the UnrealAgentLink plugin is connected.'
          }
        }

        const resolvedBlueprint = await resolveBlueprintPathInput(input.blueprint_path)
        if (!resolvedBlueprint.blueprintPath) {
          return {
            success: false,
            error: resolvedBlueprint.wasPlaceholder
              ? 'Could not resolve the current Blueprint from context. Open the target Blueprint in Unreal Editor and retry.'
              : 'Missing required field: blueprint_path'
          }
        }

        const params: Record<string, unknown> = {
          blueprint_path: resolvedBlueprint.blueprintPath
        }
        if (input.save !== undefined) {
          params.save = input.save
        }

        console.log('[CompileBlueprintTool] Sending blueprint.compile request:', params)

        const response = await wsService.callRequest<CompileBlueprintResponse>(
          'blueprint.compile',
          params,
          getTargetConnectionId(),
          30000
        )

        console.log('[CompileBlueprintTool] Response received:', response ? 'ok' : 'empty')

        if (response?.ok) {
          /*
           * 要求保存却没存上，第一句就得说（AGENTS.md §5 第 14 条）。原来一律
           * 「compiled successfully」—— 编译过了、文件只读没写进去，关编辑器改动就没了，
           * 模型却以为已经落盘。没要求保存（save:false）时 saved 本来就是 false，不算失败。
           */
          const saveFailed = input.save !== false && response.saved === false
          return {
            message: saveFailed
              ? `⚠️ 蓝图已编译通过（${response.status}），但未能保存到磁盘：${response.path}。` +
                '改动只在内存里，关编辑器就没了。'
              : `Blueprint compiled successfully (${response.status}) at ${response.path}`,
            success: true,
            status: response.status,
            saved: response.saved,
            path: response.path,
            diagnostics: response.diagnostics ?? [],
            diagnostics_count: response.diagnostics?.length ?? 0
          }
        }

        // 编译**真的失败**（图有错）和**根本没连上**是两件事，措辞必须能分开：
        // 原来两种情况都吐 "No response or ok=false" —— 那是实现细节，
        // 不是诊断。模型看不出该去修图还是该去查连接，只能原样重试。
        const msg =
          (response as Record<string, unknown> | null)?.error ||
          (response as Record<string, unknown> | null)?.message ||
          (response
            ? `蓝图编译未通过（状态 ${response.status ?? '未知'}）。请按下面的诊断逐条修图后重新编译。`
            : '引擎没有返回编译结果，可能是连接中断或编译超时。')
        const code =
          (response as { __rpc?: { code?: number }; code?: number } | null)?.__rpc?.code ??
          (response as { code?: number } | null)?.code
        const details = (response as { details?: unknown } | null)?.details

        return {
          success: false,
          error: `Failed to compile Blueprint: ${String(msg)}`,
          code,
          details,
          raw: response,
          status: response?.status,
          saved: response?.saved,
          path: response?.path,
          diagnostics: response?.diagnostics ?? [],
          diagnostics_count: response?.diagnostics?.length ?? 0,
          message: response?.status
            ? `Blueprint compile failed (${response.status}). Inspect diagnostics/details and repair the graph.`
            : 'Blueprint compile failed. Inspect diagnostics/details and repair the graph.'
        }
      } catch (error) {
        console.error('[CompileBlueprintTool] Execution failed:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
