/**
 * `cpp_compile` —— 把改过的 C++ 编进正在跑的编辑器。
 *
 * 两条路的能力差是**不对称**的，这个工具的主要工作就是把这个差异如实讲清楚：
 *
 *   - 热重载路：编不过时能拿到 UBT 的完整输出，解析出文件名和行号；
 *   - Live Coding 路：编不过时**什么都拿不到**（编译器输出只在它自己的控制台
 *     窗口里，不落盘 —— 真机验过，）。
 *
 * 所以 Live Coding 失败时不能硬凑诊断，只能说「我读不到」，并把那条出路
 * （关掉 Live Coding 重启编辑器）递给用户。难看，但比编一个假的诊断强。
 */

import { z } from 'zod'

import { defineUeTool } from '../../defineUeTool'
import type { UnrealAgentTool } from '../../defineTool'
import { formatDiagnostic, parseDiagnostics } from './diagnostics'

export interface CppCompileResponse {
  path?: 'livecoding' | 'hotreload'
  result?: string
  output?: string
  duration_ms?: number
  needs_full_rebuild?: boolean
  compilation_result?: number
  /** `NotStarted` 时插件给的原因。一行都没编的时候，这是唯一有信息量的字段 */
  reason?: string
}

/** 冷编译能到几分钟，默认的 30 秒必然超时。插件端自己 15 分钟兜底，这里留点余量 */
const TIMEOUT_MS = 20 * 60 * 1000

const LIVE_CODING_NO_DIAGNOSTICS =
  'Live Coding 的编译器报错只显示在 Live Coding 控制台窗口里，不写日志文件，我读不到。' +
  '要拿到带文件名和行号的报错，请让用户在编辑器设置里关掉 Live Coding 后重启 —— 那条路我能给出完整诊断。'

function summarize(response: CppCompileResponse): string {
  const lines: string[] = []
  const seconds = ((response.duration_ms ?? 0) / 1000).toFixed(1)
  const path = response.path === 'livecoding' ? 'Live Coding' : '热重载'

  switch (response.result) {
    case 'Success':
      lines.push(`✓ 编译成功并已加载（${path}，${seconds} 秒）`)
      break
    case 'NoChanges':
      lines.push(`编译跑完了，但引擎没检测到任何代码改动（${path}，${seconds} 秒）。`)
      lines.push('如果你刚才确实改了代码：确认文件已保存，且改的是这个工程正在用的那份源码。')
      break
    case 'Timeout':
      // 不知道成没成的时候就说不知道
      lines.push(`⚠ 编译在 15 分钟内没有结束，我不知道它成功了没有（${path}）。`)
      lines.push('请让用户看一眼编辑器，确认编译状态后再决定下一步。')
      break
    case 'CompileStillActive':
      lines.push('已经有一次编译在跑，这次没有发起。等它结束再试。')
      break
    case 'Unknown':
      // **不能说成「编译失败」。** 我们只是没能确认结果 —— 编译可能成功了。
      // 说成失败会让模型去改一份本来没问题的代码
      lines.push(`⚠ 编译跑完了，但我没能确认它成没成（${path}，${seconds} 秒）。`)
      lines.push(
        '请让用户看一眼编辑器（Live Coding 控制台或输出日志）再决定下一步，不要假设它失败了。'
      )
      break
    case 'NotStarted':
      // 一行都没编。**不能说成「编译失败」** —— 那会让模型去改代码找不存在的语法错误。
      // 真机验收案例 2 上，热重载被引擎同步拒绝，而工具那时候只会干等到超时
      lines.push(`✗ 编译**没有发起**，一行都没编（${path}）。`)
      lines.push(response.reason || '插件没有给出原因。')
      lines.push('这不是代码编不过，改代码解决不了 —— 先把上面这个前提条件解决掉。')
      break
    default:
      lines.push(`✗ 编译失败（${path}，${seconds} 秒）`)
  }

  const diagnostics = parseDiagnostics(response.output ?? '')
  if (diagnostics.length > 0) {
    lines.push('', ...diagnostics.map(formatDiagnostic))
  } else if (response.result === 'Failure' || response.result === 'Unknown') {
    if (response.path === 'livecoding') {
      lines.push('', LIVE_CODING_NO_DIAGNOSTICS)
    } else {
      // 解析器认不出来的错误（UHT 报错、UBT 自己抛的异常、本地化过的编译器输出）
      // 不能因为「解析失败」就在模型面前消失
      const tail = (response.output ?? '').split(/\r?\n/).slice(-40).join('\n').trim()
      lines.push('', '没能解析出结构化的错误，下面是输出的最后几十行原文：', tail || '(输出是空的)')
    }
  }

  /*
   * `.Build.cs` 比产物新时的提示。
   *
   * **措辞按 2026-09-08 的真机结果改过一次。**
   * 原文说的是「改依赖、加模块这类改动热重载和 Live Coding 都补不上，需要关掉
   * 编辑器完整重编」。验收案例 4 实测把它推翻了：给模块新增 Slate/SlateCore 依赖、
   * include 新头文件、调用 FSlateApplication —— 热重载**编过了也链上了**，
   * 控制台打印出了依赖生效后的结果。
   *
   * 那条文案的代价不是「说得保守一点」，是模型会据此让用户去关编辑器重编一次，
   * 而那件事在这个场景里根本不必要。所以现在只陈述事实（配置比产物新）＋
   * 一个可执行的确认动作，不再下「必须重编」的结论。
   */
  if (response.needs_full_rebuild) {
    lines.push('', '注意：磁盘上的 .Build.cs 或 .uproject 比编译产物还新，说明构建配置动过。')
    if (response.path === 'livecoding') {
      // Live Coding 只打补丁，链接期的东西它碰不到。这一格没有被实测推翻
      lines.push(
        'Live Coding 只打二进制补丁，补不上新的模块依赖 —— 它可能报成功，但新依赖没链进去。' +
          '要改依赖，请让用户关掉 Live Coding 重启编辑器（那条路能处理），或者关掉编辑器完整重编。'
      )
    } else {
      lines.push(
        '**给模块新增依赖这一类改动，热重载是能处理的**（2026-09-08 实测：加 Slate/SlateCore ' +
          '并调用新模块的 API，22 秒编过且生效，不用关编辑器）。所以不要因为这条提示就让用户关编辑器。',
        '但「在 .uproject 里加新模块」「改目标设置」超出热重载的能力范围，那类改动才需要完整重编。' +
          '拿不准就让用户验证一下新依赖那部分的行为，别只看「编译成功」。'
      )
    }
  }

  if (
    response.result !== 'Success' &&
    /C2084|already has a body|已有主体/.test(response.output ?? '')
  ) {
    lines.push(
      '新增文件可能改变 Unity 合并编译顺序，暴露旧文件间的同名函数冲突；先核对诊断中的两处定义，不要据此猜动画逻辑有错。'
    )
  }
  return lines.join('\n')
}

export function createCppCompileTool(): UnrealAgentTool<CppCompileResponse> {
  return defineUeTool<z.ZodObject<Record<string, never>>, CppCompileResponse>({
    name: 'cpp_compile',
    namespace: 'ue.cpp',
    method: 'cpp.compile',
    // 不改磁盘上的源码，产物都在 Binaries/Intermediate（删掉能重建）；
    // 但会替换正在跑的编辑器进程里的代码，绝不是只读
    risk: 'mutating',
    concurrency: 'sequential',
    timeoutMs: TIMEOUT_MS,
    input: z.object({}),
    description:
      '编译当前虚幻工程的 C++ 改动，并热加载进正在运行的编辑器。**不需要用户关闭编辑器**。\n\n' +
      '【这是编 UE 工程的默认路，别自己去 run_shell_command 调 Build.bat】' +
      '那条路要先请用户关掉编辑器，而本工具不用，报错也带文件名和行号。' +
      '只有一种情况轮得到它：本工具报了 needs_full_rebuild 且走的是 Live Coding —— ' +
      '那是链接期的改动，补丁式热更补不上，必须请用户关掉编辑器完整重编一次，' +
      '那时候才用 run_shell_command 走 Build.bat。\n\n' +
      '【什么时候用】改完 .cpp / .h 之后。改完不编，用户在编辑器里看到的还是旧代码。\n' +
      '【编译期间编辑器不会卡住】异步执行，可能要几十秒到几分钟。\n' +
      '【编不过时能拿到什么】看走的哪条路（用 cpp_probe 先看）：\n' +
      '- 热重载路：完整的编译器报错，带文件名和行号。\n' +
      '- Live Coding 路：**只知道失败了，拿不到报错内容** —— 那些只显示在 Live Coding 控制台窗口里。' +
      '这时候要建议用户关掉 Live Coding 重启编辑器，而不是瞎猜哪一行错了。\n' +
      '【改了 .Build.cs 或 .uproject 之后不要指望它】那类改动要完整重新链接，' +
      '得关掉编辑器在 IDE 里编一次。返回里的 needs_full_rebuild 会提醒你。',
    /*
     * 编译失败**不标 isError**。
     *
     * `defineTool` 见到 isError 会抛 ToolFailure，那是「工具本身出毛病了」的通道；
     * 而编不过是一个**正常的、模型必须读进去然后据此改代码**的结果。走异常通道
     * 会把 details 丢掉，正文里的诊断也变成一句异常消息。
     * 正文第一个字符是 ✗，模型看得见。
     */
    toOutcome: (response) => ({ text: summarize(response), details: response })
  })
}
