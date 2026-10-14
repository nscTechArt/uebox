/**
 * 执行控制台指令工具
 * 通过 WebSocket 向虚幻引擎插件发送 system.run_console_command 命令
 * 在当前 World 上执行任意控制台指令
 *
 * 改 cvar / ShowFlag 的命令会顺手记账（原值是多少），`restore_all` 按账改回去。
 * 为什么要记、怎么读原值，见 consoleSettingLedger.ts。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import {
  forget,
  hasRecord,
  listModified,
  parseCvarValue,
  parseSettingCommand,
  recordChange
} from './consoleSettingLedger'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 执行控制台指令请求参数
 */
const RunConsoleCommandParamsSchema = z.object({
  command: z.string().optional().describe('控制台指令'),
  restore_all: z.boolean().optional().describe('改回本工具改过的所有设置')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 执行控制台指令响应数据 */
interface RunConsoleCommandResponse {
  result: 'OK' | 'Failed'
}

type ExecResult =
  | { ok: true; output?: string; outputNote?: string; truncated?: number }
  | {
      ok: false
      result?: string
      error: string
      code?: unknown
      details?: unknown
      raw?: unknown
    }

async function execOnce(command: string, connectionId: string | undefined): Promise<ExecResult> {
  const wsService = serviceManager.getWebSocketService()
  console.log('[RunConsoleCommandTool] 发送 system.run_console_command 请求:', { command })

  const response = await wsService.callRequest<RunConsoleCommandResponse>(
    'system.run_console_command',
    { command },
    connectionId,
    30000
  )

  console.log('[RunConsoleCommandTool] 收到响应:', response)

  if (!response) {
    return { ok: false, error: '服务未返回有效数据' }
  }

  // RPC 错误/失败透传
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcOk = (response as any)?.ok
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcSuccess = (response as any)?.success
  const isSuccess = response.result === 'OK'

  if (rpcOk === false || rpcSuccess === false || !isSuccess) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = (response as any)?.error || (response as any)?.message || '执行失败'
    return {
      ok: false,
      result: response.result,
      error: `控制台指令执行失败：${msg}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code: (response as any)?.__rpc?.code ?? (response as any)?.code,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      details: (response as any)?.details,
      raw: response
    }
  }

  // 引擎侧现在会把命令的文字输出一并带回。不透传的话，
  // 查询类命令（cvar 当前值、stat、obj list）等于白跑 ——
  // 调用方能执行却看不到结果。
  return {
    ok: true,
    output: (response as { output?: string }).output,
    outputNote: (response as { output_note?: string }).output_note,
    truncated: (response as { output_truncated_chars?: number }).output_truncated_chars
  }
}

async function restoreAll(connectionId: string | undefined): Promise<Record<string, unknown>> {
  const pending = listModified(connectionId)
  if (pending.length === 0) {
    return { success: true, restored: [], message: '没有需要还原的设置。' }
  }

  const restored: string[] = []
  const failed: { name: string; original: string; error: string }[] = []
  for (const { name, original } of pending) {
    const r = await execOnce(`${name} ${original}`, connectionId)
    if (r.ok) {
      forget(connectionId, name)
      restored.push(`${name} ${original}`)
    } else {
      failed.push({ name, original, error: r.error })
    }
  }

  let message = `已还原 ${restored.length} 项设置：${restored.join('，') || '无'}。`
  if (failed.length > 0) {
    message += `\n${failed.length} 项还原失败，需要如实告诉用户：${failed
      .map((f) => `${f.name}（原值 ${f.original}）`)
      .join('，')}`
  }
  return { success: failed.length === 0, restored, failed, message }
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
    description: `在虚幻引擎中执行控制台指令（Editor/PIE 均可），会带回命令的文字输出。

示例：stat unit、r.ScreenPercentage（不带值即查询当前值）、ShowFlag.DynamicShadows 0
要看画面用 ue_screenshot，别用 HighResShot——它只写磁盘，你看不到图。

用数字改 r.* / ShowFlag.* 时会自动记下原值：这些设置退出 PIE 不复位。结果里的 modified_settings 是还没改回的项；用完调 restore_all: true 全部改回。`,

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

        const connectionId = getTargetConnectionId()

        if (input.restore_all) {
          return await restoreAll(connectionId)
        }

        const command = input.command?.trim()
        if (!command) {
          return { success: false, error: '缺少 command（或传 restore_all: true）' }
        }

        // 改设置之前先查原值。已经记过账的不用再查——账上留的是第一次的原值
        const setting = parseSettingCommand(command)
        let original: string | null = null
        if (setting && !hasRecord(connectionId, setting.name)) {
          const probe = await execOnce(setting.name, connectionId)
          original = probe.ok ? parseCvarValue(probe.output) : null
        }

        const r = await execOnce(command, connectionId)
        if (!r.ok) {
          return {
            success: false,
            result: r.result,
            error: r.error,
            code: r.code,
            details: r.details,
            raw: r.raw
          }
        }

        if (setting) {
          recordChange(connectionId, setting.name, original, setting.value)
        }
        const modified = listModified(connectionId)

        return {
          success: true,
          result: 'OK',
          output: r.output,
          ...(modified.length > 0 ? { modified_settings: modified } : {}),
          message:
            `控制台指令 "${command}" 执行成功` +
            (r.output
              ? `
输出：
${r.output}` +
                (r.truncated
                  ? `
（前 ${r.truncated} 个字符已截断）`
                  : '')
              : r.outputNote
                ? `
${r.outputNote}`
                : '') +
            (modified.length > 0
              ? `
目前有 ${modified.length} 项设置还没改回原值，用完调 restore_all: true。`
              : '')
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
