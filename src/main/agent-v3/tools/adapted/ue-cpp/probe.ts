/**
 * `cpp_probe` —— 动手写 UE C++ 之前必须先问一次的那个问题：
 * **这个工程、这个编辑器会话，代码能怎么编？**
 *
 * ## 为什么这是一个独立工具，而不是编译工具内部的一步
 *
 * 因为答案会改变**写代码之前**的决策，不只是编译时的分支：
 *
 *   - `has_code === false` → 纯蓝图工程，一行 C++ 都不该开始写；
 *     引擎的建类路在这种工程上会弹模态对话框，而命令跑在游戏线程上，
 *     弹出来就是编辑器和调用一起卡死。要先请用户手动加第一个类。
 *   - `compile_path === 'livecoding'` → 编得动，但**编不过时拿不到报错**
 *     （Live Coding 的编译器输出只在它自己的控制台窗口里，不落盘 ——
 *     这是真机验过的，）。
 *     知道这一点，模型就该在动手前先建议用户关掉 Live Coding，
 *     而不是等编译失败了才发现自己两眼一抹黑。
 *
 * 把它塞进编译工具里，这些判断就只能在「代码已经写完」之后发生。
 *
 * ## 它绝对不能有副作用
 *
 * 尤其不能启用 Live Coding。`ILiveCodingModule::Compile()` 一进门就
 * `EnableForSession(true)`，会把一个关着 Live Coding 的会话永久切过去，
 * 之后热重载在这个会话里就一律失败了。所以 probe 只读状态，risk = safe。
 * 插件侧的对应约束写在 `UAL_CppCommands.cpp` 的 `Handle_Probe` 里。
 */

import { z } from 'zod'

import { defineUeTool } from '../../defineUeTool'
import type { UnrealAgentTool } from '../../defineTool'

export interface CppProbeResponse {
  has_code?: boolean
  /**
   * .uproject 里声明了几个模块。
   *
   * 和 `has_code` 是两个数据源（前者读 .uproject，后者数磁盘上的源文件），
   * 会不一致 —— 不一致本身就是结论，见 summarize() 里的注释。
   */
  declared_module_count?: number
  compile_path?: 'livecoding' | 'hotreload' | 'none'
  compile_path_reason?: string
  engine_dir?: string
  engine_source_dir?: string
  project_source_dir?: string
  live_coding?: {
    available?: boolean
    started?: boolean
    enabled_by_default?: boolean
    enabled_for_session?: boolean
    can_enable?: boolean
    is_compiling?: boolean
    enable_error?: string
    unavailable_reason?: string
  }
  hot_reload?: {
    available?: boolean
    any_game_module_loaded?: boolean
    is_compiling?: boolean
    /**
     * 引擎眼里「重新绑定得动」的包有几个。**这个是 0 的话热重载编不动**，
     * 哪怕 `any_game_module_loaded` 是 true —— 引擎按 UObject 包重绑，
     * 模块里一个 UCLASS 都没有就没有包。2026-09-08 真机验收案例 2 撞到过。
     */
    reloadable_package_count?: number
  }
}

/**
 * 把探测结果讲成人话。
 *
 * 不直接 `JSON.stringify` 整个响应：那里面十几个布尔位长得都一样
 * （`started` / `enabled_by_default` / `enabled_for_session` / `can_enable`），
 * 而只有一个决定走哪条路。原样丢给模型，它会挑一个看起来顺眼的去推理。
 * 结论先写，状态位留在 details 里备查。
 */
function summarize(response: CppProbeResponse): string {
  const lines: string[] = []

  // has_code=false 有两种，处置完全不同：真的没 C++（纯蓝图），
  // 和 .uproject 声明了模块但源码目录不存在（工程坏了）。
  // 只按 has_code 一个位下结论，会把后者说成前者，然后把用户引向
  // 「手动加第一个类」——而他的问题是工程本身缺了 Source。
  // 这是真机读回时撞出来的，详见 listModules.ts 里 summarize 的注释。
  if (response.has_code === false && (response.declared_module_count ?? 0) > 0) {
    lines.push(
      `⚠️ .uproject 声明了 ${response.declared_module_count} 个模块，但磁盘上找不到源码文件。` +
        '这**不是**纯蓝图工程，是一个源码缺失的 C++ 工程。'
    )
  } else if (response.has_code === false) {
    lines.push('这是**纯蓝图工程**（没有 C++ 源码）。')
  }

  const path = response.compile_path ?? 'none'
  const pathLabel = {
    livecoding: 'Live Coding',
    hotreload: '热重载（HotReload）',
    none: '无可用编译路径'
  }[path]
  lines.push(`编译路径：${pathLabel}`)

  if (response.compile_path_reason) lines.push(response.compile_path_reason)

  // 这个数只在热重载路上有意义，而且**必须出现在正文里**：
  // 真机验收时模型被问到它，只能回「未提供」——因为它当时只在 details 里。
  // 模型读不到的字段等于不存在。
  const reloadable = response.hot_reload?.reloadable_package_count
  if (path === 'hotreload' && reloadable !== undefined) {
    lines.push(
      `可热重载的模块包：${reloadable} 个${reloadable === 0 ? '（这条路现在编不动）' : ''}`
    )
  }

  if (response.engine_source_dir) {
    lines.push(
      `引擎源码在 ${response.engine_source_dir} —— ` +
        'UE 的 API 在版本之间会变，拿不准某个函数的签名就去这里 grep，不要凭记忆写。'
    )
  }
  if (response.project_source_dir) {
    lines.push(`工程源码在 ${response.project_source_dir}`)
  }

  return lines.join('\n')
}

export function createCppProbeTool(): UnrealAgentTool<CppProbeResponse> {
  return defineUeTool<z.ZodObject<Record<string, never>>, CppProbeResponse>({
    name: 'cpp_probe',
    namespace: 'ue.cpp',
    method: 'cpp.probe',
    risk: 'safe',
    input: z.object({}),
    description:
      '探测当前虚幻工程的 C++ 编译能力：有没有 C++ 源码、这个编辑器会话该走哪条编译路、引擎和工程源码在哪。\n\n' +
      '【什么时候用】**写或改 UE C++ 代码之前先调一次**。它回答的是「能不能编、编不过时能不能拿到报错」，' +
      '这两件事会改变你要不要动手、以及要不要先请用户改设置。\n' +
      '【返回里最重要的两条】\n' +
      '- has_code=false：纯蓝图工程，不要试图加 C++ 类，先请用户在编辑器里手动加一次（File > New C++ Class）。\n' +
      '- compile_path=livecoding：编得动，但**编不过时拿不到文件名和行号**（Live Coding 的报错只在它自己的窗口里）。' +
      '要完整诊断就先建议用户关掉 Live Coding 重启编辑器。\n' +
      '【不会改变任何状态】它只读，不会启用 Live Coding，也不会触发编译。',
    toOutcome: (response) => ({ text: summarize(response), details: response })
  })
}
