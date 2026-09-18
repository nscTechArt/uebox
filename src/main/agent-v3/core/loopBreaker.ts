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
 */

import type {
  AfterToolCallContext,
  BeforeToolCallContext,
  BeforeToolCallResult
} from '@earendil-works/pi-agent-core'

/**
 * 同一「工具+参数」允许失败几次。
 *
 * 2 的含义：第一次失败是信息（模型据此换路子），第二次是确认，第三次开始算撞墙。
 * 给到 2 而不是 1，是因为有些失败确实值得重试一次（瞬时的引擎断连、锁竞争）。
 */
export const MAX_IDENTICAL_FAILURES = 2

/** 参数可能含循环引用或不可序列化的值，序列化失败时退回工具名 —— 宁可放行 */
function callKey(toolName: string, args: unknown): string {
  try {
    return `${toolName}::${JSON.stringify(args)}`
  } catch {
    return `${toolName}::<unserializable>`
  }
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
export function createLoopBreaker(limit: number = MAX_IDENTICAL_FAILURES): LoopBreaker {
  const failures = new Map<string, number>()

  return {
    before(ctx) {
      const key = callKey(ctx.toolCall.name, ctx.args)
      if ((failures.get(key) ?? 0) < limit) return undefined

      return {
        block: true,
        // 这段会作为 tool result 交给模型，所以写成「对模型的指示」而不是
        // 「对用户的提示」—— 写成后者模型会把它当成环境噪音继续重试。
        reason:
          `${ctx.toolCall.name} 用完全相同的参数已经失败 ${limit} 次，这次调用被拦下了。` +
          '不要再用这组参数重试。请改用不同的参数、换一个工具，' +
          '或者直接告诉用户卡在哪里、需要什么信息才能继续。'
      }
    },

    after(ctx) {
      const key = callKey(ctx.toolCall.name, ctx.args)
      if (ctx.isError) {
        failures.set(key, (failures.get(key) ?? 0) + 1)
      } else {
        // 成功一次就清零：间歇性故障（引擎重连中）不该累积成熔断
        failures.delete(key)
      }
    }
  }
}
