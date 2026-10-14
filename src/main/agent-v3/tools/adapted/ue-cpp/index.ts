/**
 * UE C++ 工作流工具。
 *
 * 设计与取证。
 */

import type { UnrealAgentTool } from '../../defineTool'
import { createCppProbeTool } from './probe'
import { createCppListModulesTool } from './listModules'
import { createCppCompileTool } from './compile'
import { createCppAddClassTool } from './addClass'
import { createCppFullRebuildTool } from './fullRebuild'

export { createCppProbeTool } from './probe'
export { createCppListModulesTool } from './listModules'
export { createCppCompileTool } from './compile'
export { createCppAddClassTool } from './addClass'
export { createCppFullRebuildTool } from './fullRebuild'

/**
 * 这些都是 **V3 原生**工具（`defineUeTool` / `defineTool` 直接产出，自带 risk 与命名空间），
 * 所以不进 `registry.ts` 的 `REGISTRATIONS` —— 那张表里的东西会再过一遍
 * `adaptV2Tool`，而适配层要的是 V2 的 `inputSchema`/`execute`，
 * 原生工具没有那两个字段，会在**造 agent 的时候**直接抛。
 * 和 mesh / sequencer / material 一样，在 `buildAllTools()` 里直接拼进去。
 */
export function cppTools(): UnrealAgentTool<never>[] {
  return [
    createCppProbeTool(),
    createCppListModulesTool(),
    createCppAddClassTool(),
    createCppCompileTool(),
    createCppFullRebuildTool()
  ] as unknown as UnrealAgentTool<never>[]
}

/*
 * ## cpp_add_class 曾经摘掉过一个月（2026-09-08 → 2026-10-12）
 *
 * 那时它包的是 `GameProjectUtils::AddCodeToProject`，在真实工程上不返回：
 * AddCodeToProject → FSourceCodeNavigation::AddSourceFiles → GetSourceFileDatabase()
 * 同步扫全部源码，编辑器停在「正在添加代码到项目…… 14%」。摘掉期间的口径是
 * 「请用户在编辑器里手动建」—— 结果模型在用户明确授权之后仍然拒绝写文件，
 * 反复让用户去点菜单（2026-10-12 用户反馈）。
 *
 * 现在插件照抄引擎的生成那一半（同一份模板、同一套占位符），不碰那个扫描，
 * 只写文件不编译；编译走 cpp_compile，编辑器补不上的走 cpp_full_rebuild。
 * 详见插件 UAL_CppCommands.cpp 的 cpp.add_class 段。
 */
