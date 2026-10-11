/**
 * 重复失败熔断。
 *
 * ## 为什么需要
 *
 * V2 最被诟病的行为是「撞墙」：一个工具调失败，模型改个无关紧要的措辞再调一次，
 * 又失败，如此往复直到用户手动打断。pi 的循环本身**不设步数上限**
 * （`agentLoop.integration.test.ts` 里 20 轮长链路不被截断，那是有意的），
 * 所以这条防线得我们自己建。
 *
 * ## 为什么不靠模型自觉
 *
 * 接真实模型验证时，我连着换了三种写法都没能让 DeepSeek 去调一个必定失败的工具 ——
 * 它每次都先自己推理出「这个参数不合法/资产不存在」然后拒绝调用。
 * 好模型确实不太撞墙。但护栏是给**坏情况**准备的：换个模型、换个 provider、
 * 或者工具因为引擎断连而间歇性失败时，那个循环就会真的转起来。
 * 判定线不能建立在「模型足够聪明」上。
 *
 * ## 判定口径
 *
 * 按 **工具名 + 参数** 计数，不是按工具名。同一个工具换参数重试是正常的
 * 排查行为（搜不到就换关键词），必须放行；一字不差地重发才是撞墙。
 * 成功一次就清零 —— 间歇性故障不该累积成熔断。
 *
 * ## 世界变了，旧账就作废
 *
 * 「一字不差地重发」只在**中间什么都没变**时才是撞墙。改代码 → `cpp_compile` →
 * 再改 → 再 `cpp_compile` 是正常的修错循环：编译参数一字不差，但源文件已经不同了。
 * 所以任何一次**成功的非只读调用**（改了文件、改了资产、跑了命令）都把所有失败
 * 计数清零。只读调用（搜索、读文件）不清零 —— 它们不改变下一次调用的结果。
 *
 * 另外有一类工具，同一组参数本来就该得到不同结果（编译、打包、试玩、截图、
 * 跑命令）：它们的结果取决于工程此刻的状态，而状态可能被盒子之外的东西改掉
 * （用户在编辑器里动手、UE 自己热重载）。这类给更宽的阈值，而不是完全放开 ——
 * 什么都没变就连发五次编译，仍然是撞墙。
 */

import type {
  AfterToolCallContext,
  BeforeToolCallContext,
  BeforeToolCallResult
} from '@earendil-works/pi-agent-core'

import { effectiveRisk, type ToolMeta } from '../tools/defineTool'

/**
 * 同一「工具+参数」允许失败几次。
 *
 * 2 的含义：第一次失败是信息（模型据此换路子），第二次是确认，第三次开始算撞墙。
 * 给到 2 而不是 1，是因为有些失败确实值得重试一次（瞬时的引擎断连、锁竞争）。
 */
export const MAX_IDENTICAL_FAILURES = 2

/** 结果随工程状态变化的工具（见文件头）用的阈值 */
export const MAX_VOLATILE_FAILURES = 5

/** 同一组参数本来就可能得到不同结果的工具 */
export const VOLATILE_TOOLS: ReadonlySet<string> = new Set([
  'cpp_compile',
  'cpp_full_rebuild',
  'blueprint_compile',
  'blueprint_compile_all',
  'material_compile',
  'ue_playtest',
  'ue_autoplay',
  'ue_screenshot',
  'project_package',
  'run_shell_command'
])

/** 参数可能含循环引用或不可序列化的值，序列化失败时退回工具名 —— 宁可放行 */
function callKey(toolName: string, args: unknown): string {
  try {
    return `${toolName}::${JSON.stringify(args)}`
  } catch {
    return `${toolName}::<unserializable>`
  }
}

export interface LoopBreakerDeps {
  /**
   * 按名字查工具元数据，用来判断一次成功调用是不是改动了世界。
   * 省略时从钩子上下文的 `context.tools` 里找。
   */
  lookup?: (toolName: string) => { unrealBox?: ToolMeta } | undefined
}

export interface LoopBreaker {
  before: (ctx: BeforeToolCallContext) => BeforeToolCallResult | undefined
  after: (ctx: AfterToolCallContext) => void
}

/**
 * 造一个会话级的熔断器。
 *
 * 两个钩子都**不抛异常**：熔断器自身出问题不该让 agent 罢工，
 * 这和审批门是同一条契约。
 */
export function createLoopBreaker(
  limit: number = MAX_IDENTICAL_FAILURES,
  deps: LoopBreakerDeps = {}
): LoopBreaker {
  const failures = new Map<string, number>()
  const limitFor = (toolName: string): number =>
    VOLATILE_TOOLS.has(toolName) ? Math.max(limit, MAX_VOLATILE_FAILURES) : limit

  /**
   * 这次成功的调用有没有改动世界。查不到元数据（未知工具）按「没改」算 ——
   * 宁可保留计数，也不让一个来历不明的调用把熔断洗掉。
   */
  const changedWorld = (ctx: AfterToolCallContext): boolean => {
    try {
      const name = ctx.toolCall.name
      const tool =
        deps.lookup?.(name) ??
        (ctx.context?.tools?.find((t) => t.name === name) as { unrealBox?: ToolMeta } | undefined)
      const meta = tool?.unrealBox
      if (!meta) return false
      return effectiveRisk(meta, ctx.args) !== 'safe'
    } catch {
      return false
    }
  }

  return {
    before(ctx) {
      const key = callKey(ctx.toolCall.name, ctx.args)
      const max = limitFor(ctx.toolCall.name)
      if ((failures.get(key) ?? 0) < max) return undefined

      return {
        block: true,
        // 这段会作为 tool result 交给模型，所以写成「对模型的指示」而不是
        // 「对用户的提示」—— 写成后者模型会把它当成环境噪音继续重试。
        reason:
          `${ctx.toolCall.name} 用完全相同的参数已经失败 ${max} 次，这次调用被拦下了。` +
          '不要再用这组参数重试。请改用不同的参数、换一个工具，' +
          '或者直接告诉用户卡在哪里、需要什么信息才能继续。'
      }
    },

    after(ctx) {
      const key = callKey(ctx.toolCall.name, ctx.args)
      if (ctx.isError) {
        failures.set(key, (failures.get(key) ?? 0) + 1)
      } else if (changedWorld(ctx)) {
        // 成功改动了文件/资产/工程：之前失败的调用这次可能就过了，旧账全部作废
        failures.clear()
      } else {
        // 成功一次就清零：间歇性故障（引擎重连中）不该累积成熔断
        failures.delete(key)
      }
    }
  }
}
