/**
 * `cpp_list_modules` —— 这个工程有哪些 C++ 模块、源码在哪、各是什么类型。
 *
 * ## 为什么需要它
 *
 * 「把这个类加到哪个模块里」是写 UE C++ 时绕不开的第一个问题，而模型手上原本
 * 没有任何工具能回答。它只能去猜工程名同名的那个模块，猜中的概率在多模块工程
 * （游戏模块 + 编辑器模块 + 若干插件模块）里并不高。
 *
 * ## 为什么 type 字段不是装饰
 *
 * `Runtime` / `Editor` / `Developer` 决定了这个模块能 include 什么。往 Runtime
 * 模块里 include `UnrealEd` 是最典型的「开发时全绿、打包时全红」——
 * 编辑器构建里 UnrealEd 就在，编得过；打包成游戏时它不存在，链接直接失败。
 * 把类型摆在模型面前，是让它在选模块的那一刻就能避开这个坑。
 *
 * ## 为什么走引擎的 GetCurrentProjectModules 而不是自己扫目录
 *
 * 「什么算一个模块」的定义在引擎手里（.uproject / .uplugin 的 Modules 段 +
 * Build.cs 的存在）。自己扫 Source 目录数出来的东西和引擎认的不一致时，
 * 后面每一步都会错位。
 */

import { z } from 'zod'

import { defineUeTool } from '../../defineUeTool'
import type { UnrealAgentTool } from '../../defineTool'

export interface CppModule {
  name?: string
  source_path?: string
  /** Runtime / Editor / Developer / Program … */
  type?: string
  /** `project` = 工程自己的模块；`plugin` = 插件的模块 */
  origin?: string
}

export interface CppListModulesResponse {
  modules?: CppModule[]
  count?: number
  has_code?: boolean
  /** .uproject 的 Modules 段里声明了几个（新插件才有）。纯蓝图工程为 0 */
  declared_module_count?: number
}

const InputSchema = z.object({
  include_plugins: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      '是否连工程内插件的模块一起列出来（默认 false，只列工程自己的）。' +
        '要往某个插件里加代码时才需要打开'
    )
})

/**
 * `has_code` 和模块列表**会不一致**，分清两种：
 *
 *   - 纯蓝图工程：引擎的 `GetCurrentProjectModules()` 会塞一个以工程名命名的**占位模块**
 *     （给新建类向导用，磁盘上并不存在）。2026-09-03 在 ProbeHost 上看到的
 *     「has_code=false 却列出一个模块」就是它 —— 当时误判成了源码丢失，
 *     结果每个纯蓝图工程都被说成坏工程（10-12 真机在 BPOnly52 上查实）。
 *     新插件已经不列这个占位，并给出 `declared_module_count`（读 .uproject 本身）。
 *   - .uproject 真的声明了模块、源码却不在：这才是坏掉的 C++ 工程。
 *
 * 老插件没有 `declared_module_count`，那时只能按「列表里有没有东西」判，保持原样。
 */
function summarize(response: CppListModulesResponse): string {
  const declared = response.declared_module_count
  // 新插件：.uproject 一个模块都没声明 = 纯蓝图，列表里那个是引擎的占位，不算数
  const modules = response.has_code === false && declared === 0 ? [] : (response.modules ?? [])

  if (modules.length === 0) {
    if (response.has_code === false) {
      return (
        '这是纯蓝图工程，没有 C++ 模块。' +
        '直接用 cpp_add_class 建第一个类（module 留空），它会和编辑器一样顺带建好以工程名命名的主模块；' +
        '新模块正在跑的编辑器加载不了，填完实现后用 cpp_full_rebuild 编译并重开编辑器。'
      )
    }
    // has_code 为真却一个模块都没有，是个矛盾状态。如实说出来，
    // 别回一句「共 0 个模块」让模型以为这是正常结果
    return '工程报告有 C++ 代码，但一个模块都没列出来。这不正常，请让用户确认工程能否正常编译。'
  }

  const mismatch =
    response.has_code === false
      ? [
          '',
          '⚠️ 注意：.uproject 声明了上面这些模块，但磁盘上找不到源码文件' +
            '（Source 目录不存在或是空的）。这不是纯蓝图工程，是一个**源码缺失**的 C++ 工程 —— ' +
            '加新类解决不了，请让用户确认工程拷贝时是不是漏了 Source 目录。'
        ]
      : []

  const lines = modules.map(
    (m) =>
      `- ${m.name ?? '(无名)'} [${m.type ?? '未知类型'}${m.origin === 'plugin' ? '，插件' : ''}]  ${m.source_path ?? ''}`
  )

  return [
    `共 ${modules.length} 个模块：`,
    ...lines,
    '',
    '选模块时注意 type：往 Runtime 模块里 include UnrealEd 之类的编辑器模块，' +
      '在编辑器里编得过，打包成游戏时会链接失败。',
    ...mismatch
  ].join('\n')
}

export function createCppListModulesTool(): UnrealAgentTool<CppListModulesResponse> {
  return defineUeTool<typeof InputSchema, CppListModulesResponse>({
    name: 'cpp_list_modules',
    namespace: 'ue.cpp',
    method: 'cpp.list_modules',
    risk: 'safe',
    input: InputSchema,
    description:
      '列出当前虚幻工程的 C++ 模块：模块名、源码目录（绝对路径）、模块类型（Runtime / Editor / Developer）。\n\n' +
      '【什么时候用】要往工程里加或改 C++ 代码，需要先确定放进哪个模块时。\n' +
      '【为什么要看 type】Runtime 模块不能 include UnrealEd 这类编辑器模块 —— ' +
      '在编辑器里编得过，打包成游戏时会链接失败。选模块时先看类型。\n' +
      '【和 cpp_probe 的分工】cpp_probe 回答「能不能编」，这个回答「往哪儿写」。',
    toOutcome: (response) => ({ text: summarize(response), details: response })
  })
}
