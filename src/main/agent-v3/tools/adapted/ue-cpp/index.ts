/**
 * UE C++ 工作流工具。
 *
 * 设计与取证。
 */

import type { UnrealAgentTool } from '../../defineTool'
import { createCppProbeTool } from './probe'
import { createCppListModulesTool } from './listModules'
import { createCppCompileTool } from './compile'
// createCppAddClassTool 只 re-export 不 import —— 它现在没挂进 cppTools()，
// import 进来会被 noUnusedLocals 拦下。摘掉的理由见文件末尾那段长注释。

export { createCppProbeTool } from './probe'
export { createCppListModulesTool } from './listModules'
export { createCppCompileTool } from './compile'
export { createCppAddClassTool } from './addClass'

/**
 * 这些都是 **V3 原生**工具（`defineUeTool` 直接产出，自带 risk 与命名空间），
 * 所以不进 `registry.ts` 的 `REGISTRATIONS` —— 那张表里的东西会再过一遍
 * `adaptV2Tool`，而适配层要的是 V2 的 `inputSchema`/`execute`，
 * 原生工具没有那两个字段，会在**造 agent 的时候**直接抛。
 * 和 mesh / sequencer / material 一样，在 `buildAllTools()` 里直接拼进去。
 */
export function cppTools(): UnrealAgentTool<never>[] {
  return [
    createCppProbeTool(),
    createCppListModulesTool(),
    createCppCompileTool()
    // ⛔ createCppAddClassTool() 暂不注册 —— 见下。
  ] as unknown as UnrealAgentTool<never>[]
}

/*
 * ## 为什么 `cpp_add_class` 现在不注册（2026-09-08）
 *
 * 它包的 `GameProjectUtils::AddCodeToProject` **在真实工程上不返回**。
 * 真机验收案例 5 连续三轮都卡住：文件生成了，然后编辑器停在
 * 「正在添加代码到项目…… 14%」，10 分钟后工具超时，`result` 一直没回来。
 *
 * 卡点已经定位到具体一步（独立实验工程上逐步排除，记录在
 * 的第四次记录里）：
 *
 *   AddCodeToProject
 *     → FSourceCodeNavigation::AddSourceFiles
 *       → GetSourceFileDatabase()   ← **就是这里**
 *
 * `GetSourceFileDatabase()` 会把引擎 + 工程 + 所有插件的 .Build.cs 和源文件
 * 全扫一遍，同步跑在游戏线程上；在装了多个引擎的机器上它不收敛。
 * 而且扫完什么也不做 —— Visual Studio 那个 `AddSourceFiles` 在 5.5 里是
 * `#if 0` 关掉的（VisualStudioSourceCodeAccessor.cpp:1224）。**纯粹白等。**
 *
 * 排除过程里顺带证伪的两条（省得下次重走）：
 *   - 不是等编译：卡住期间轮询 12 次进程表，UBT / cl.exe 一个都没有
 *   - 不是那段同步热重载：`bAutomaticallyHotReloadNewClasses=False` 之后照样卡，
 *     而且运行时确认读到的就是 False
 *
 * **代码和测试都留着，只是不挂上去**：卡的不是我们的逻辑，是这个引擎 API 的选路。
 * 重做方案（自己读引擎的类模板生成两个文件，然后走已经验证好用的异步 `cpp_compile`）
 * 已经和维护者对过，等案例 6–10 跑完再单独做。删了它下次要从头查一遍。
 *
 * 在那之前，「帮我建个 C++ 类」的正确回答是：**请用户在编辑器里手动建一次**
 * （菜单 工具 > 新建 C++ 类），之后改代码和编译我们都接得住。
 * 这条已经写进 resources/skills/ue-cpp-workflow/SKILL.md。
 */
