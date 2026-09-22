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
import { describePositionalRotatorRefusal, findPositionalRotatorCalls } from './pythonRotatorGuard'
import { noteViewportMove, viewportCameraApiInScript } from '../ue-editor/viewportProvenance'

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

【旋转一律写关键字】\`unreal.Rotator\` 的**位置参数顺序是 (roll, pitch, yaw)**，跟 JSON / 蓝图的
(pitch, yaw, roll) 相反。\`unreal.Rotator(0, 90, 0)\` 得到的是 pitch=90 不是 yaw=90 —— 墙横着躺、
镜头朝天，引擎不报任何错。所以写 \`unreal.Rotator(roll=0, pitch=0, yaw=90)\`；带位置参数的写法
这个工具会直接拒绝执行。摆完东西用 ue_get_actor 回读，它会把旋转翻成「正面朝哪」的人话。

【注意】：脚本在编辑器主线程上同步执行，最多等待 5 分钟。超时或停止等待不代表 UE 已停止执行，先回读确认，不能直接重复修改。

【三件事别在 Python 里做】
- **PIE 起停**：editor_play_simulate() / editor_request_end_play() 都是「下一帧才生效」，脚本占着游戏线程，
  同一脚本里 sleep 或回读永远看到旧状态（世界是 None、playing 还是 True）。要跑游戏并读结果用 ue_playtest；
  非要停 PIE 就单独发一句、脚本返回后另起一次回读。
- **循环 delete_asset**：每次调用都做一次完整 GC，几百个资产就把主线程占死十几分钟。删资产、清目录用
  ue_content_delete（目录直接传，一批提交）。
- **猜 API 名**：AttributeError 一次就是一整个往返。先 print(dir(obj)) 和 print(obj.method.__doc__) 拿到
  真实名字和签名再调。`,

    inputSchema: RunPythonScriptParamsSchema,

    execute: async (input, options?: { abortSignal?: AbortSignal }) => {
      console.log('[RunPythonScriptTool] 收到请求:', { description: input.description })

      // 这段脚本跑在 UE 进程里，但 UE 的 Python 有完整的 open() ——
      // 本地文件工具那边挡着的凭据目录，从这里读一样读得到。
      // 边界漏一个出口就不成其为边界，而这是除 shell 之外最宽的那个。
      const denied = assertScriptAllowed(input.script)
      if (denied) return { success: false, error: denied }

      // unreal.Rotator(a, b, c) 的位置参数顺序是 (roll, pitch, yaw)，按直觉传会静默转错方向。
      // 真机上 78 个部件因此全摆错。这里拦下来让模型改成关键字，比事后回读便宜得多。
      const rotatorHits = findPositionalRotatorCalls(input.script)
      if (rotatorHits.length > 0) {
        return { success: false, error: describePositionalRotatorRefusal(rotatorHits) }
      }

      // 脚本要动关卡视口相机 —— 先记一笔，ue_screenshot 拍视口时会把它说出来。
      // 跑成没跑成都记：「跑成了但改坏了」正是要抓的情形
      const cameraApi = viewportCameraApiInScript(input.script)
      if (cameraApi) {
        noteViewportMove('ue_run_python_script', `脚本里调了 ${cameraApi}`)
      }

      const result = await runEditorPython(
        input.script,
        input.description || 'Python 脚本',
        300_000,
        options?.abortSignal
      )

      if (!result.success) {
        if (options?.abortSignal?.aborted || result.aborted) {
          return { success: false, aborted: true, error: result.error }
        }
        /*
         * 「没确认上」才补这段排查指引，脚本自己报错不补。
         *
         * 主线程被死循环占住时，后面每一条命令（连只读的）都会一起超时 ——
         * 试探问不出任何东西，只是每次再赔一个超时。真机上撞到过：一个 `continue`
         * 前不前进的循环卡死编辑器，之后又白发了两条命令才反应过来。能在这种状态下
         * 回话的只有 `ue_session_health`（进程检测在盒子侧做，不走引擎 RPC）。
         *
         * 拼在这里而不是 `runEditorPython` 里：那个 `error` 还有两条路会原样弹给
         * 用户看，而这段话是说给模型听的、还点名了一个用户调不到的工具。
         */
        const hint = result.unconfirmed
          ? '\n不要再发命令试探 —— 主线程被占住时所有命令都会一起超时。' +
            '先用 ue_session_health 看编辑器进程还在不在，真卡死了请用户重启编辑器，' +
            '重启后先回读现场再继续。'
          : ''
        // V3 的失败适配只保留 error/details；stdout 单独放顶层会被丢掉。
        return {
          success: false,
          error: (result.error ?? 'Python 执行失败') + hint,
          details: { stdout: result.stdout }
        }
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
