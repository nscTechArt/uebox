/**
 * `task` 子 agent 工具 —— 取代 V2 的 `route_to_specialist`。
 *
 * **关键区别：传的是 transcript 快照，不是字符串。**
 *
 * V2 的委派工具描述里写着「专家无法看到对话历史！」，Router 只能把任务压成
 * 一个自包含字符串丢过去。专家拿不到之前的工具结果、拿不到已探测出的资产路径、
 * 拿不到用户原话，于是 prompt 里堆满「禁止猜测路径」之类的补丁。委派次数越多，
 * 信息损耗累积越狠 —— 这是 V2 复杂任务做不好的头号原因。
 *
 * 这里的子 agent 直接继承父 agent 的消息数组，没有那道损耗。
 *
 * 另外 V2 有两道硬上限也一并取消：同一专家一轮只能跑一次（completedSpecialists
 * 拦截）、每个专家最多 10 步。子 agent 可以反复起、跑到任务完成为止。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'

/**
 * 把还没有结果的工具调用从继承的上下文里摘掉。
 *
 * **不摘就会凭空造出一次失败。** 父 agent 的那条 assistant 消息在工具开始执行
 * **之前**就进了 transcript（pi 边流式边 push），所以子 agent 继承到的最后一条
 * 里，正是「派出你自己」的那次 `task` 调用 —— 而它此刻当然还没有结果。
 * pi-ai 发请求前会给这种孤儿调用补一条合成结果：
 * `{ text: 'No result provided', isError: true }`（transform-messages.js:138）。
 *
 * 于是每个子 agent 睁眼看到的第一件事都是「你的调用方刚派任务失败了」。
 * 真机上它的反应完全合理也完全错误：以为要重派，去调 `task` —— 而子 agent
 * 手里没有这个工具，于是拿到第二条错误 `Tool task not found`，两条一起写进
 * 交回来的报告。用户读到的就是「三路子任务都没派出去」，而三路其实都在跑。
 * 报告里记下的失败顺序（先 No result provided、后 Tool task not found）
 * 正是这条因果链。
 *
 * 并行派出去的兄弟调用同理：它们的结果对这一路也不存在，一并摘掉。
 */
export function stripPendingToolCalls(messages: readonly AgentMessage[]): AgentMessage[] {
  const settled = new Set<string>()
  for (const message of messages) {
    const record = message as { role?: string; toolCallId?: string }
    if (record.role === 'toolResult' && typeof record.toolCallId === 'string') {
      settled.add(record.toolCallId)
    }
  }

  const kept: AgentMessage[] = []
  for (const message of messages) {
    const record = message as { role?: string; content?: unknown }
    if (record.role !== 'assistant' || !Array.isArray(record.content)) {
      kept.push(message)
      continue
    }

    const content = record.content.filter((block) => {
      const item = block as { type?: string; id?: string }
      return item.type !== 'toolCall' || (item.id ? settled.has(item.id) : false)
    })
    if (content.length === record.content.length) {
      kept.push(message)
      continue
    }
    // 整条只剩空壳就别留了：一条没有任何内容的 assistant 消息对模型是噪音
    if (content.length > 0) {
      kept.push({ ...(message as object), content } as AgentMessage)
    }
  }

  return kept
}

/** 子 agent 运行结果 */
export interface SubAgentResult {
  text: string
  /** 子 agent 内部跑了多少条消息，用于界面展示和成本归因 */
  messageCount: number
  /**
   * 这一路调用过的写工具及次数，例如 `{ ue_set_transform: 6, ue_save: 1 }`。
   *
   * 跟着结论一起回给父 agent：没有它，两份互相矛盾的报告谁真谁假只能靠
   * 自己把场景读一遍对账（实测里就这么白走了三轮批量查询）。
   */
  writeToolCalls?: Record<string, number>
  /** 这一路是不是以只读模式跑的 */
  readOnly?: boolean
}

/**
 * 把写操作计数写成一行给模型看的话。
 *
 * **必须进正文**，不能只挂在 `details` 上 —— 那里的东西模型根本看不到，
 * 等于没给。
 */
export function formatWriteAudit(result: SubAgentResult): string {
  const entries = Object.entries(result.writeToolCalls ?? {})
  if (entries.length === 0) {
    return result.readOnly
      ? '【本次子任务的写操作】无 —— 这一路以只读模式运行，写工具不在它的清单里。'
      : '【本次子任务的写操作】无，它只调用了只读工具。'
  }

  const list = entries
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ×${count}`)
    .join('、')
  return `【本次子任务的写操作】${list}。这些改动**已经发生**，需要的话自己回读确认，或用 ue_undo 回滚。`
}

export interface TaskToolDeps {
  /**
   * 起一个子 agent 并跑完。
   *
   * 由 `createAgent` 注入而不是这里直接 import —— 否则 createAgent 与 task
   * 互相 import 成环。
   */
  runSubAgent: (input: {
    prompt: string
    /** 限定可用工具的命名空间。undefined 表示继承全部 */
    namespaces?: string[]
    /** 传给子 agent 的起始消息。这就是与 V2 的本质区别 */
    /** 只读子任务：写工具不进它的工具清单 */
    readOnly?: boolean
    seedMessages: AgentMessage[]
    signal?: AbortSignal
    onProgress?: (text: string) => void
  }) => Promise<SubAgentResult>

  /** 取当前父 agent 的 transcript。延迟到调用时取，拿到的才是最新的 */
  getParentMessages: () => AgentMessage[]

  /** 生成父上下文的摘要，供 contextMode: 'summary' 使用 */
  summarize?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<string>
}

const taskInput = z.object({
  prompt: z
    .string()
    .describe(
      '给子 agent 的任务描述。不需要重复背景 —— 它默认能看到当前对话的全部上下文。\n' +
        '**别派「先打开工程再干活」这种活。** 子 agent 的工具清单在它开工那一刻就定死了：' +
        '它就算真把工程打开了，这一轮也拿不到引擎工具，只会回一句「引擎没连上」。' +
        '要开工程就自己先开完，再把后面的活派出去。'
    ),
  namespaces: z
    .array(z.string())
    .optional()
    .describe(
      '限定子 agent 可用的工具命名空间，如 ["ue.material"]。省略则继承全部工具。' +
        '缩小范围能让子 agent 更专注，但范围给窄了它会因为缺工具而卡住。'
    ),
  read_only: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      '把这一路限制成只读：它拿到的工具清单里**根本没有写工具**，不是靠提示词劝阻。' +
        '评审、盘点、检查、找问题这类「产出是一份报告」的子任务一律开着它 —— ' +
        '不开的话，子 agent 完全可能一边写报告一边「顺手修好」，把用户的场景改了还存了盘。'
    ),
  context_mode: z
    .enum(['inherit', 'summary', 'fresh'])
    .optional()
    .default('inherit')
    .describe(
      'inherit=继承完整对话（默认，信息最全）；' +
        'summary=只给父对话的摘要（父对话很长时用）；' +
        'fresh=只给 prompt，不带任何历史（任务与当前对话无关时用）'
    )
})

export function createTaskTool(deps: TaskToolDeps): UnrealAgentTool<SubAgentResult> {
  return defineTool<typeof taskInput, SubAgentResult>({
    name: 'task',
    namespace: 'core',
    // 子 agent 自己会受审批门约束，起一个子 agent 本身不改任何东西
    risk: 'safe',
    // 多个 task 可并发 —— 天然支持「三个子 agent 分别审查同一份蓝图」这类多视角用法
    concurrency: 'parallel',
    description: `把一个界定清晰的子任务交给独立的子 agent 执行。

【什么时候用】
- 子任务会产生大量中间探索（如遍历几百个资产找符合条件的），你不想让这些噪音污染当前对话
- 子任务需要长时间反复迭代（如把蓝图连线改到编译通过）
- 需要多个独立视角（并发起多个 task，让它们分别审查同一份资产）

【什么时候不用】
- 单步就能做完 —— 直接调对应工具，别套一层
- 需要和用户来回确认 —— 子 agent 无法与用户交互

【产出是报告的，一律开 read_only】
评审、盘点、检查、找问题 —— 只要这一路的产出是文字而不是改动，就传 read_only: true。
开了它写工具根本不在子 agent 手上；不开的话，在 prompt 里写多少条「禁止修改」都拦不住它
「顺手修好」，而它改的是用户的工程。

子 agent 默认继承当前对话的完整上下文，**你不需要把背景重复写进 prompt**。
它返回的是最终结论，中间过程不会进入当前对话；结论末尾会附一行它实际做过的写操作。`,
    input: taskInput,
    execute: async ({ prompt, namespaces, context_mode, read_only }, ctx) => {
      // 摘掉还没有结果的工具调用 —— 其中就有「派出这一路」的这次调用本身，
      // 留着它子 agent 第一眼看到的就是一条凭空的失败（见 stripPendingToolCalls）
      const parentMessages = stripPendingToolCalls(deps.getParentMessages())

      let seedMessages: AgentMessage[] = []
      if (context_mode === 'inherit') {
        seedMessages = parentMessages
      } else if (context_mode === 'summary') {
        if (deps.summarize && parentMessages.length > 0) {
          const summary = await deps.summarize(parentMessages, ctx.signal)
          seedMessages = [
            {
              role: 'user',
              content: `【当前对话的背景摘要】\n\n${summary}`,
              timestamp: 0
            } as unknown as AgentMessage
          ]
        } else {
          // 摘要不可用时退回完整上下文，而不是静默丢掉全部背景 ——
          // 后者会让子 agent 在没有前提的情况下瞎干。
          seedMessages = parentMessages
        }
      }

      const result = await deps.runSubAgent({
        prompt,
        ...(namespaces ? { namespaces } : {}),
        ...(read_only ? { readOnly: true } : {}),
        seedMessages,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        // 子 agent 的进度实时冒泡到界面，用户能看到它在干什么
        onProgress: (text) => ctx.report({ text })
      })

      // 审计那一行跟着结论走。子 agent 的结论是它自己写的，可能与事实不符；
      // 这一行不是它写的，是记账记出来的
      return {
        text: `${result.text}

${formatWriteAudit(result)}`,
        details: result
      }
    }
  })
}
