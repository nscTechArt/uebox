/**
 * 执行 Python 脚本工具。
 *
 * 实际执行走 `core/editorPython.ts` 的 `runEditorPython`（插件 `cmd.run_python`），
 * 这里只负责边界检查和把结果讲给模型听。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'

import { runEditorPython } from '../../../core/editorPython'
import { assertScriptAllowed } from '../../builtin/pathBoundary'

const RunPythonScriptParamsSchema = z.object({
  script: z.string().describe('要执行的 Python 脚本内容'),
  description: z.string().optional().describe('脚本用途描述，用于日志记录')
})

/**
 * 创建执行 Python 脚本工具
 * @returns 执行 Python 脚本工具实例
 */
export function createRunPythonScriptTool(): V2Tool {
  return defineV2Tool({
    description: `在虚幻引擎中执行 Python 脚本 —— 读和写都可以。

【功能说明】：用于没有专用工具覆盖的查询、统计、批量操作。
有专用工具的事情优先用专用工具，Python 是补充。

【怎么拿到结果】：
1. \`print()\` 的内容会被捕获并回传（截取最后 8000 字符）。
2. 结构化数据赋值给全局变量 \`output_data\`，工具会自动带回。
   - 示例：\`output_data = {"assets": ["/Game/A"], "count": 1}\`
   - 数据量大、需要后续处理时用它，比 print 可靠。

【改完要标脏，这一步会丢数据】：Python 不走事务系统，包不标脏 \`ue_save\` 就一个字节
都不写、也不报错。改完必须 \`asset.modify()\`，存盘用 \`save_asset(path, only_if_is_dirty=False)\`，
回读看文件时间戳（\`load_asset\` 查的是内存，查不出来）。

【unreal 的 API 别靠猜，当场问它】：参数写错通常只返回 False，一个字的原因都没有
（\`rename_asset\` 的新名要完整包路径，写成纯名字就静默失败）。没把握就先
\`print(unreal.EditorAssetLibrary.rename_asset.__doc__)\`，一次调用拿到签名，
比改一个参数试一次快得多。

【注意】：脚本在编辑器主线程上同步执行，最多等待 5 分钟。超时或停止等待不代表 UE 已停止执行，先回读确认，不能直接重复修改。`,

    inputSchema: RunPythonScriptParamsSchema,

    execute: async (input, options?: { abortSignal?: AbortSignal }) => {
      console.log('[RunPythonScriptTool] 收到请求:', { description: input.description })

      // 这段脚本跑在 UE 进程里，但 UE 的 Python 有完整的 open() ——
      // 本地文件工具那边挡着的凭据目录，从这里读一样读得到。
      // 边界漏一个出口就不成其为边界，而这是除 shell 之外最宽的那个。
      const denied = assertScriptAllowed(input.script)
      if (denied) return { success: false, error: denied }

      const result = await runEditorPython(
        input.script,
        input.description || 'Python 脚本',
        300_000,
        options?.abortSignal
      )

      if (!result.success) {
        if (options?.abortSignal?.aborted) {
          return { success: false, aborted: true, error: result.error }
        }
        // V3 的失败适配只保留 error/details；stdout 单独放顶层会被丢掉。
        return { success: false, error: result.error, details: { stdout: result.stdout } }
      }

      let message = 'Python 脚本执行成功'
      if (result.stdout) {
        message += `\nstdout:\n${result.stdout}`
      } else if (!result.output) {
        // 两个都没有才是真的什么都没返回 —— 打破「成功但无数据」的死循环
        message +=
          ' (注意：脚本没有任何输出。用 print(...) 打印，或把结构化数据赋给 output_data 变量。)'
      }

      return {
        success: true,
        message,
        details: { output: result.output, stdout: result.stdout },
        // 🎯 Layer 1: 直接嵌入工具返回值的收敛引导 — 模型在对话上下文中直接看到
        _aiInstruction:
          '脚本已成功执行。请先判断是否还需要一次有针对性的验证；如果任务已经满足，就汇总真实结果并调用 done。不要重复执行功能相同的脚本。'
      }
    }
  })
}
