/**
 * `update_plan` 和 `wrap_up` —— 一轮活的开头和结尾，跟用户交代的两件事。
 *
 * ## 为什么是工具，不是让界面从回复里猜
 *
 * 任务清单和「接下来你定哪件事」都只有干活的模型说得准。界面去回复正文里
 * 抠编号列表、抠问句，抠错一次就是画出一个用户没法回答的问题。
 * 模型调了就显示，没调就什么都不显示 —— 不猜。
 *
 * ## 和建议按钮的关系
 *
 * 回复下面那排建议按钮原来全靠一次单独的模型调用事后猜。`wrap_up` 调了，
 * 那排按钮就换成它给的（上面多一行问题），猜的那次调用不再发；没调照旧。
 * 渲染层见 `renderer/.../composables/agentTurnReport.ts`。
 *
 * ## 谁拿得到
 *
 * 和 `ask_user` 一样：只给有人看着界面的主 agent（`createAgent.ts` 里按
 * `requestQuestion` 判断）。子 agent、定时任务没人看清单、也没人点按钮。
 */

import { z } from 'zod'

import {
  MAX_PLAN_ITEM_CHARS,
  MAX_PLAN_ITEMS,
  MAX_WRAP_UP_ACTIONS,
  MAX_WRAP_UP_ASK_CHARS,
  MAX_WRAP_UP_LABEL_CHARS,
  MAX_WRAP_UP_MESSAGE_CHARS,
  UPDATE_PLAN_TOOL_NAME,
  WRAP_UP_TOOL_NAME,
  type PlanItem,
  type PlanSnapshot,
  type WrapUp
} from '../../../../shared/agentTurnReport'
import { defineTool, type UnrealAgentTool } from '../defineTool'

// 描述用英文、参数不带 describe：这两个工具常驻，每个字节每轮都要带上（见
// `toolSearchCatalog.test.ts` 的 80,000 那条线）。中文一个字三字节，写法说明放描述正文里一次说完
const planInput = z.object({
  items: z
    .array(
      z.object({
        content: z.string().min(1).max(MAX_PLAN_ITEM_CHARS),
        status: z.enum(['pending', 'in_progress', 'completed'])
      })
    )
    .min(1)
    .max(MAX_PLAN_ITEMS)
    .optional(),
  advance: z.boolean().optional()
})

const PLAN_DESCRIPTION =
  'Show the user a task list for this turn. For work with 3+ steps, call once before starting with all items ' +
  '(short imperative phrases in the user language; first in_progress, rest pending). After each step, call with ' +
  'advance=true alongside the next tool call; after the last step, call it once more before your final reply. ' +
  'Resend items if the plan changes.'

/** 推进一步：进行中的打勾，下一个待办开始。没有进行中的就直接开下一个 */
export function advancePlan(items: PlanItem[]): PlanItem[] {
  const next = items.map((item) => ({ ...item }))
  const current = next.findIndex((item) => item.status === 'in_progress')
  if (current >= 0) next[current].status = 'completed'
  const pending = next.findIndex((item) => item.status === 'pending')
  if (pending >= 0) next[pending].status = 'in_progress'
  return next
}

/** 每个清单工具实例手上的那张清单，给 `planReminder` 读 */
const planOf = new WeakMap<object, () => PlanItem[]>()

export function createUpdatePlanTool(): UnrealAgentTool<PlanSnapshot> {
  // 每轮现造一次（见 `resolveCandidateTools`），清单状态跟着这一轮走
  let items: PlanItem[] = []
  const tool = defineTool<typeof planInput, PlanSnapshot>({
    name: UPDATE_PLAN_TOOL_NAME,
    namespace: 'host',
    description: PLAN_DESCRIPTION,
    input: planInput,
    risk: 'safe',
    concurrency: 'sequential',
    execute: async (args) => {
      if (args.items) items = args.items.map((item) => ({ ...item, content: item.content.trim() }))
      else if (args.advance && items.length > 0) items = advancePlan(items)
      else
        return {
          isError: true,
          text:
            items.length === 0
              ? '第一次调用要给出整张清单（items）。'
              : '给 items 或 advance=true。'
        }
      const done = items.filter((item) => item.status === 'completed').length
      // 真机上 deepseek-flash 做完最后一步直接写总结，清单停在「进行中」——
      // 原描述说「和下一个工具调用一起推进」，最后一步后面没有下一个调用了。描述已改，这里再提一句
      const left = items.length - done
      return {
        text:
          left === 0
            ? '清单已全部完成。'
            : `清单已更新：${done}/${items.length} 步完成。最后一步做完也要 advance 一次再写最终回复。`,
        details: { items }
      }
    }
  })
  planOf.set(tool, () => items)
  return tool
}

/**
 * 清单没走完时，挂在这一步最后一个工具结果后面的那句提醒；不用提醒返回 undefined。
 *
 * 真机上工作室模式的制作人建完清单后连调 73 次工具（派活、等回话、看产出）
 * 一次 advance 都没有，界面上第一步转了一个多小时。推进的说明只在 `update_plan`
 * 自己的结果里出现过一次，几十步以后早被淹了。
 *
 * 不数步数：每一步（一条助手消息）都挂，只挂在它最后一个调用上，并行调用不重复；
 * 这一步自己调了 `update_plan` 就不挂。措辞留「还在做就不用管」，免得把没做完的步骤催成打勾。
 */
export function planReminder(
  tools: readonly object[],
  assistantMessage: { content: readonly { type: string; id?: string; name?: string }[] },
  toolCallId: string
): string | undefined {
  const tool = tools.find((t) => (t as { name?: string }).name === UPDATE_PLAN_TOOL_NAME)
  const items = tool ? planOf.get(tool)?.() : undefined
  if (!items) return undefined
  const calls = assistantMessage.content.filter((block) => block.type === 'toolCall')
  if (calls.at(-1)?.id !== toolCallId) return undefined
  if (calls.some((call) => call.name === UPDATE_PLAN_TOOL_NAME)) return undefined
  const current = items.findIndex((item) => item.status !== 'completed')
  if (current < 0) return undefined
  return (
    `（清单第 ${current + 1}/${items.length} 步「${items[current].content}」还没打勾。` +
    '这步已经做完就带上 update_plan advance=true；还在做就不用管。）'
  )
}

const wrapUpInput = z.object({
  ask: z.string().min(1).max(MAX_WRAP_UP_ASK_CHARS),
  actions: z
    .array(
      z.object({
        label: z.string().min(1).max(MAX_WRAP_UP_LABEL_CHARS),
        message: z.string().max(MAX_WRAP_UP_MESSAGE_CHARS).optional()
      })
    )
    .min(1)
    .max(MAX_WRAP_UP_ACTIONS)
})

const WRAP_UP_DESCRIPTION =
  'If your turn ends with a decision for the user, show one short question with 1-2 reply buttons under your ' +
  'reply (first = your pick; label 2-6 words). A click sends message (or label) to you as the user. ' +
  'Call it last; do not repeat the question in your reply.'

export function createWrapUpTool(): UnrealAgentTool<WrapUp> {
  return defineTool<typeof wrapUpInput, WrapUp>({
    name: WRAP_UP_TOOL_NAME,
    namespace: 'host',
    description: WRAP_UP_DESCRIPTION,
    input: wrapUpInput,
    risk: 'safe',
    concurrency: 'sequential',
    execute: async (args) => {
      const wrapUp: WrapUp = {
        ask: args.ask.trim(),
        actions: args.actions.map((action) => ({
          label: action.label.trim(),
          ...(action.message?.trim() ? { message: action.message.trim() } : {})
        }))
      }
      return {
        text: '问题和按钮已显示在回复下方。写完最终回复就结束这一轮，不要再调工具。',
        details: wrapUp
      }
    }
  })
}
