/**
 * `blueprint_compile_all` —— 批量编译蓝图。
 *
 * 此前只有单个蓝图的编译。改了一批蓝图、或者改了一个被很多蓝图继承的父类
 * 之后想确认工程还编得过，只能一个一个调，几十次往返。
 *
 * 默认只编「本插件改脏的那些」。全量扫描会把 path 下所有蓝图加载进内存，
 * 大工程里要几分钟 —— 那个开销只在用户明确要求全查时才值得付。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

interface CompileFailure {
  path: string
  errors: number
  warnings: number
  messages: Array<{ severity: string; message: string }>
}

interface CompileAllResponse {
  ok: boolean
  scope: string
  compiled_count: number
  error_count: number
  warning_count: number
  failures: CompileFailure[]
  truncated?: boolean
  truncated_note?: string
  note?: string
}

const CompileAllSchema = z.object({
  scope: z
    .enum(['touched', 'all'])
    .optional()
    .describe('touched=只编你改过的（默认，快）；all=扫 path 下全部蓝图（大工程要几分钟）'),
  path: z.string().optional().describe('scope=all 时的搜索根路径，默认 /Game'),
  limit: z.number().int().optional().describe('最多编几个，默认 200，上限 2000')
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createCompileAllBlueprintsTool() {
  return defineV2Tool({
    description: `一次编译多个蓝图，返回出问题的那些。

改完一批蓝图之后用它收尾，比一个一个调 blueprint_compile 快得多。
改了被继承的父类之后尤其该跑一次 —— 子蓝图可能被改坏了而你不知道。

默认只编你自己改过的。scope="all" 会把整个路径下的蓝图都加载并编译，
大工程里要几分钟，只在需要全面体检时用。

返回里只列**有错误或警告的**蓝图，编过的不占篇幅。
truncated=true 表示到了数量上限、还有蓝图没编 —— 这种情况下
"0 个错误"不代表整个工程都过了。`,

    inputSchema: CompileAllSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const params: Record<string, unknown> = {}
        if (input.scope) params.scope = input.scope
        if (input.path) params.path = input.path
        if (input.limit !== undefined) params.limit = input.limit

        // 全量编译要加载并编译成百上千个蓝图，超时给得比别的命令宽
        const response = await wsService.callRequest<CompileAllResponse>(
          'blueprint.compile_all',
          params,
          getTargetConnectionId(),
          600000
        )

        if (!response) {
          return { success: false, error: '插件没有响应（blueprint.compile_all）' }
        }

        /**
         * 错误响应要在这里拦住。
         *
         * 插件用 `code>=400` 报错时，`callRequest` 归一成 `{ ok:false, error }`
         * —— **没有 `failures` 数组**。下面那句 `response.failures.length` 会抛
         * TypeError；就算侥幸不抛，这个函数也会带着一堆 undefined 返回
         * `success: true`，把一次失败的调用报成「没有需要编译的蓝图」。
         *
         * 同 `ue_save` 那个坑（saveChanges.ts 里的长注释），判据只看数组在不在：
         * 编译有错误时插件也可能回 `ok:false`，但那份响应是完整的，要照常报出来。
         */
        if (!Array.isArray(response.failures)) {
          const raw = response as unknown as Record<string, unknown>
          return {
            success: false,
            error:
              (typeof raw.error === 'string' ? raw.error : '') ||
              (typeof raw.message === 'string' ? raw.message : '') ||
              '插件回了一个错误响应，但没说原因（blueprint.compile_all）'
          }
        }

        // 有编译错误**不算调用失败** —— 工具正常工作了，是蓝图有问题。
        // 报成 success:false 会让模型去排查工具而不是去修蓝图。
        return {
          success: true,
          scope: response.scope,
          compiled_count: response.compiled_count,
          error_count: response.error_count,
          warning_count: response.warning_count,
          failures: response.failures,
          ...(response.truncated
            ? { truncated: true, truncated_note: response.truncated_note }
            : {}),
          ...(response.note ? { note: response.note } : {}),
          summary:
            response.compiled_count === 0
              ? (response.note ?? '没有需要编译的蓝图')
              : `编译了 ${response.compiled_count} 个蓝图：${response.error_count} 个错误、` +
                `${response.warning_count} 个警告` +
                (response.failures.length > 0
                  ? `，有问题的 ${response.failures.length} 个都在 failures 里`
                  : '，全部通过') +
                (response.truncated ? '（到了上限，还有没编的）' : '')
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
