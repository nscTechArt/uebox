/**
 * `cpp_add_class` —— 新建一个 C++ 类。
 *
 * ## 产出和编辑器「新建 C++ 类」逐字相同，但不走它那条路
 *
 * 引擎那条路（`GameProjectUtils::AddCodeToProject`）在真实工程上不返回：里面有一步
 * 同步扫全部源码给 IDE 用，编辑器停在「正在添加代码到项目…… 14%」。插件现在照抄它的
 * 「生成」那一半 —— 同一份引擎类模板、同一套占位符、同样的 API 宏和 .uproject 依赖登记 ——
 * 只写文件，**不编译**。细节在插件 `UAL_CppCommands.cpp` 的 cpp.add_class 那段。
 *
 * 所以这个工具的回执要把下一步讲死：填实现 → `cpp_compile`。纯蓝图工程的第一个类会顺带
 * 建出工程主模块，那个模块编辑器当场加载不了，下一步是 `cpp_full_rebuild`。
 *
 * ## 为什么不让模型直接写 .h/.cpp 顶替
 *
 * 模型凭记忆写的类和引擎模板差在细节上：`.generated.h` 的位置、`<MODULE>_API` 宏
 * 该不该带（Private 下的不带）、老式 PCH 工程要不要先 include 模块头、父类所在模块
 * 要不要登记依赖。每一处差了都是一次编译失败，而且是模型最难读懂的那种 UHT 报错。
 * 有了这个工具，「自己写文件建类」就没有理由存在了 —— 不是禁止，是没必要。
 */

import { z } from 'zod'

import { defineUeTool } from '../../defineUeTool'
import type { UnrealAgentTool } from '../../defineTool'

export interface CppAddClassResponse {
  result?: 'Succeeded'
  /** 带前缀的最终类名，如 ASurvivorDirector */
  class_name?: string
  /** 接口类才有：实现方要继承的那个 I 类 */
  interface_name?: string
  /** 调用方给的名字带了前缀、被剥掉时才有，原样带回 */
  requested_name?: string
  module?: string
  header_path?: string
  cpp_path?: string
  /** 插件写完后从磁盘读回的 —— 不是回显 */
  header_exists?: boolean
  cpp_exists?: boolean
  created_files?: string[]
  /** 新登记进 .uproject AdditionalDependencies 的模块 */
  dependencies_added?: string[]
  /** 纯蓝图工程的第一个类：顺带建了工程主模块（Build.cs / Target.cs / 模块 .h/.cpp） */
  created_primary_module?: boolean
  marked_for_add?: boolean
  /** 新插件恒为 false：建类不再顺带编译 */
  reloaded?: boolean
  warnings?: string[]
}

const InputSchema = z.object({
  name: z.string().min(1).describe('类名，不带 U/A/F 前缀，如 SurvivorDirector'),
  parent_class: z
    .string()
    .optional()
    .describe(
      '父类如 Actor / ActorComponent / UserWidget；Interface = 接口；SlateWidget；留空 = 普通类'
    ),
  module: z.string().optional().describe('留空 = 工程主模块'),
  location: z
    .enum(['default', 'public', 'private'])
    .optional()
    .default('default')
    .describe('public = 要被别的模块 include')
})

function summarize(response: CppAddClassResponse): string {
  const className = response.class_name ?? '新类'
  const lines: string[] = []

  // 状态以插件从磁盘读回的为准；读回说文件不在，就不能开口说建好了
  const missing = [
    response.header_exists === false ? response.header_path : undefined,
    response.cpp_exists === false ? response.cpp_path : undefined
  ].filter(Boolean)
  if (missing.length > 0) {
    lines.push(
      `⚠️ 插件报告写完了，但读回时找不到：${missing.join('、')}。先去看一眼，别直接往下写。`
    )
  } else {
    lines.push(`✓ 已在模块 ${response.module} 里创建 ${className}：`)
  }
  lines.push(`  ${response.header_path}`, `  ${response.cpp_path}`)

  if (response.interface_name) {
    lines.push(
      `这是虚幻接口：要实现它的类继承 ${response.interface_name}，接口函数声明在 ${response.interface_name} 里。`
    )
  }
  if (response.requested_name) {
    lines.push(
      `（传入的 ${response.requested_name} 已经带了前缀，没有再加一层，类名就是 ${className}）`
    )
  }

  if (response.created_primary_module) {
    const extra = (response.created_files ?? []).filter(
      (f) => f !== response.header_path && f !== response.cpp_path
    )
    lines.push(
      '',
      '这是工程的第一个 C++ 类，已经和编辑器一样顺带建好了工程主模块：',
      ...extra.map((f) => `  ${f}`),
      '**新模块正在跑的编辑器加载不了**，cpp_compile 编不进来。' +
        '下一步：先 read_local_file 看生成的文件、把实现填完，再调 cpp_full_rebuild ——' +
        '它会替用户关掉编辑器、完整编译、再打开工程并重连。'
    )
  } else {
    lines.push(
      '',
      '**还没有编译。** 下一步：read_local_file 看一眼生成的文件，把实现填完，然后调 cpp_compile。' +
        '编进来之前，编辑器里（蓝图父类列表、内容浏览器）还看不到这个类。'
    )
  }

  if (response.dependencies_added?.length) {
    lines.push(
      `已把 ${response.dependencies_added.join('、')} 登记进 .uproject 的模块依赖（父类在这些模块里）。`
    )
  }
  for (const warning of response.warnings ?? []) {
    lines.push(`⚠️ ${warning}`)
  }
  // 跳过了引擎给 IDE 刷新工程文件那一步（就是它会卡死）。只影响用户在 VS 里看不看得见新文件
  lines.push(
    '（Visual Studio / Rider 的解决方案里暂时看不到新文件，不影响编译；用户要在 IDE 里打开时，' +
      '在编辑器里点 工具 > 刷新 Visual Studio 项目 即可。用户没问就不用提。）'
  )

  return lines.join('\n')
}

export function createCppAddClassTool(): UnrealAgentTool<CppAddClassResponse> {
  return defineUeTool<typeof InputSchema, CppAddClassResponse>({
    name: 'cpp_add_class',
    namespace: 'ue.cpp',
    method: 'cpp.add_class',
    // 只新建文件、从不覆盖（重名直接拒绝），偶尔往 .uproject 补一条依赖。不编译
    risk: 'mutating',
    concurrency: 'sequential',
    timeoutMs: 60_000,
    input: InputSchema,
    description:
      '新建 C++ 类，和编辑器「新建 C++ 类」同一套引擎模板，纯蓝图工程也能用。' +
      '**建类就用它，别让用户去编辑器里点，也别 write_local_file 自己拼。**只写文件不编译，下一步见回执。',
    // 失败（类名不合法、重名、父类不可继承、模板读不到）插件走 4xx/5xx 带原话，
    // callUe 直接抛 —— 同一组参数重试会被熔断器拦下，这正是想要的
    toOutcome: (response) => ({ text: summarize(response), details: response })
  })
}
