/**
 * `cpp_add_class` —— 新建一个 C++ 类。
 *
 * ## 为什么必须走引擎的 AddCodeToProject，不能自己写文件
 *
 * 那一个函数里做完了：类名合法性校验、按父类挑模板、写 .h/.cpp、必要时补 Build.cs、
 * 源码管理 mark-for-add、以及触发一次编译。自己拼模板会漏掉后三项，
 * 而且产出和用户在编辑器里点「新建 C++ 类」得到的东西不一样 ——
 * 「AI 建的类」和「引擎建的类」长得不同，这本身就是 bug 的来源。
 *
 * ## 纯蓝图工程会被拒
 *
 * 引擎那条路在工程原先没有 C++ 时会弹模态对话框，而命令跑在游戏线程上，
 * 弹出来就是编辑器和调用一起卡死。插件侧硬拦（比引擎保守，理由写在那边）。
 */

import { z } from 'zod'

import { defineUeTool } from '../../defineUeTool'
import type { UnrealAgentTool } from '../../defineTool'

export interface CppAddClassResponse {
  result?: 'Succeeded' | 'InvalidInput' | 'FailedToAddCode' | 'FailedToHotReload' | 'Unknown'
  module?: string
  header_path?: string
  cpp_path?: string
  /** 引擎有没有顺手把新类编进来了。为 false 说明还要自己调一次 cpp_compile */
  reloaded?: boolean
  fail_reason?: string
}

const InputSchema = z.object({
  name: z
    .string()
    .describe('新类的名字，**不要带 U/A/F 前缀**（引擎会按父类自动加）。例如 TurretActor'),
  parent_class: z
    .string()
    .optional()
    .describe(
      '父类，如 Actor / ActorComponent / UserWidget / SceneComponent，' +
        '带不带 U/A 前缀都认，也可以给完整路径。' +
        '**留空表示建一个不继承 UObject 的普通 C++ 类**（纯工具类才这么用）'
    ),
  module: z
    .string()
    .optional()
    .describe('放进哪个模块。留空用工程的主模块。不确定有哪些模块先调 cpp_list_modules'),
  location: z
    .enum(['default', 'public', 'private'])
    .optional()
    .default('default')
    .describe(
      '放在模块的哪一层。default = 模块根目录（引擎对游戏模块的默认行为，绝大多数情况用这个）；' +
        'public = 要被别的模块 include 的类；private = 只在本模块内用'
    )
})

/**
 * 引擎的 FailedToHotReload 是「代码加成功了，只是没能热加载」—— 部分完成，不是没建成。
 * 抛成错误会让模型以为什么都没发生，转头再建一次，撞「文件已存在」或建出第二个类
 */
function nothingCreated(response: CppAddClassResponse): boolean {
  return response.result !== 'Succeeded' && response.result !== 'FailedToHotReload'
}

function summarize(response: CppAddClassResponse): string {
  if (response.result !== 'Succeeded') {
    return [
      response.result === 'FailedToHotReload'
        ? '⚠️ 部分完成：类文件已写出，但没能编进编辑器（FailedToHotReload）'
        : `✗ 建类失败（${response.result ?? '未知原因'}）`,
      response.fail_reason || '引擎没有给出原因。',
      response.result === 'FailedToHotReload'
        ? '注意：**文件可能已经写出去了**，只是没能编进来。先去看一眼那两个文件在不在，别重复创建。'
        : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  const lines = [
    `✓ 已在模块 ${response.module} 里创建：`,
    `  ${response.header_path}`,
    `  ${response.cpp_path}`
  ]

  lines.push(
    response.reloaded
      ? '引擎已经顺手编译并加载了它，现在就能用。'
      : '**还没有编译。** 填完实现之后调 cpp_compile。'
  )
  lines.push('接下来先 read_local_file 看一眼引擎生成了什么，再往里加实现。')

  return lines.join('\n')
}

export function createCppAddClassTool(): UnrealAgentTool<CppAddClassResponse> {
  return defineUeTool<typeof InputSchema, CppAddClassResponse>({
    name: 'cpp_add_class',
    namespace: 'ue.cpp',
    method: 'cpp.add_class',
    // 往用户的源码树里写文件，而且可能顺带触发一次编译
    risk: 'destructive',
    concurrency: 'sequential',
    // 引擎在 Live Coding 开着时会顺手编一次，那一下可能要几分钟
    timeoutMs: 10 * 60 * 1000,
    input: InputSchema,
    description:
      '在虚幻工程里新建一个 C++ 类（和编辑器里「工具 > 新建 C++ 类」是同一套逻辑）。\n\n' +
      '【什么时候用】要加一个新的 Actor、Component、Subsystem、UObject 之类的时候。\n' +
      '【不要自己写文件来建类】引擎这条路会同时处理类名校验、模板、Build.cs、' +
      '源码管理登记和编译 —— 自己写会漏掉这些，产出也和引擎建的不一样。\n' +
      '【纯蓝图工程会被拒】那种工程加第一个 C++ 类必须用户手动做一次，我做不了。\n' +
      '【建完还要做什么】返回里会说有没有顺手编译。没编就填完实现后调 cpp_compile。',
    /*
     * 没建成就标 isError。正文第一个字已经是 ✗，但不标的话宿主和熔断器都当它成功了：
     * 模型拿着同一组参数反复重建，一次都不会被拦。和 cpp_compile 不同，这里的入参
     * 就是类名，重试同一组参数本来就该被拦 —— 没有「改完代码再调同一个调用」的正常路径。
     * ToolFailure 的消息就是这段正文，引擎给的原因不会丢。
     * FailedToHotReload 不算：文件已经写出去了，见 nothingCreated。
     */
    toOutcome: (response) => ({
      text: summarize(response),
      details: response,
      ...(nothingCreated(response) ? { isError: true } : {})
    })
  })
}
