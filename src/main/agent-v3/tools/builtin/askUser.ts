/**
 * `ask_user` —— 目标不明确时，当场问用户一句。
 *
 * ## 为什么是工具，不是别的
 *
 * 三条路都试过想过：MCP 的 elicitation 是跨进程的 server→client RPC，而我们的
 * agent 就跑在主进程里，用不上那套 JSON-RPC；LangGraph 那种「存盘 + 返还控制权
 * + 从检查点恢复」是为会超时的 HTTP/serverless 连接设计的，桌面应用没有那个前提。
 * 剩下的就是本文件这条：**当成一个普通工具，就地阻塞等回答** —— Claude Code、
 * Cline、pi 的社区插件全是这么干的，而且仓库里的审批（approvalChannel.ts）
 * 已经在这么跑了，不是新赌注。
 *
 * ## 三个硬闸
 *
 * 光靠描述劝模型「少问」是不够的，所以闸门做在代码里：
 *
 *   1. **同时只允许一个**。Cline 有个未修的 issue 就是模型在规划阶段连发几个
 *      问题把状态机打乱（cline/cline#7603）。
 *   2. **一次运行最多问 3 轮**。再多就直接报错，逼它自己拿主意。
 *   3. **用户取消过一次，之后的提问不再弹窗**，直接按取消返回。刚把卡片关掉的人
 *      不该被同一个 agent 追着问第二遍。
 *
 * ## 没人回答时会一直等
 *
 * 提问**没有超时**（见 `questionChannel.ts` 的文件头）：用户没回答不代表他放弃，
 * 只代表他还没回来。卡片就一直挂在时间线上，这次运行悬停在这儿 —— 不烧 token，
 * 也不会有谁替他把这个选择做了。要收场只能由人来：回答它，或者按停止。
 *
 * ## 子 agent 拿不到这个工具
 *
 * 在 `resolveTools` 里就被 `isSubAgent` 挡掉了。子 agent 跑在用户看不见的后台，
 * 而提问没有超时 —— 给它这个工具等于允许它无声挂在那儿，直到有人想起来按停止。
 * 它遇到说不准的地方应该把不确定写进
 * 返回文本，由父 agent 决定要不要问人。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import {
  hasPendingQuestion,
  type AskUserQuestion,
  type QuestionOutcome
} from '../../host/questionChannel'

/** 一次运行最多问几轮。超了直接报错，让模型自己拿主意 */
export const MAX_ASKS_PER_RUN = 3

const askUserInput = z.object({
  questions: z
    .array(
      z.object({
        header: z
          .string()
          .max(12)
          .describe('卡片上的短标签，不超过 12 个字符，如「用在哪」「做多深」'),
        question: z.string().describe('完整的问题。说清楚你为什么问不下去了'),
        multiSelect: z.boolean().default(false).describe('选项之间不互斥、可以多选时为 true'),
        options: z
          .array(
            z.object({
              label: z.string().describe('选项标题，1~5 个词'),
              description: z.string().describe('选了会发生什么、代价是什么。不要复述 label')
            })
          )
          .min(2)
          .max(4)
          .describe('2~4 个选项。第一个放你的推荐，并在 label 末尾加「（推荐）」')
      })
    )
    .min(1)
    .max(3)
    .describe('1~3 个问题。相关的几问一次问完，别拆成多轮来回打断用户')
})

const DESCRIPTION = [
  '在动手之前问用户一句，用来收窄目标范围和边界。界面会长出一张选项卡片，',
  '用户点完你才继续。「其他（自己填）」和「你自己定」这两个出口由界面恒定提供，',
  '不用你放进选项里。',
  '',
  '什么时候用：只在**不同理解会导向实质不同的工作**时用 —— 做给谁用、做到哪一层、',
  '先做哪一个。有惯例默认值的、翻代码就能查出来的、你只是想确认一下的，自己定，',
  '然后在回复里说一句你的假设即可。',
  '',
  '硬规矩：',
  '- 动手之前问，不要做了一半才问。',
  '- 每个选项必须是一条真实存在的分支，写清代价，不要造凑数选项。',
  '- 一次运行最多问 3 轮，超了会直接报错。',
  '- 永远不要用它索取密码、密钥、令牌、账号一类的凭据。'
].join('\n')

export interface AskUserToolDeps {
  sessionId: string
  /** 向用户发起提问，由 `host/questionChannel.ts` 构造 */
  request: (
    req: { sessionId: string; toolCallId: string; questions: AskUserQuestion[] },
    signal?: AbortSignal
  ) => Promise<QuestionOutcome>
}

/**
 * 把用户的选择写成给模型看的一段话。
 *
 * 逐问带上 header，模型才对得上哪个答案回的是哪一问 —— 一次问三问、
 * 回来一个没有标签的列表，它会把顺序记串。
 */
export function formatAnswers(questions: AskUserQuestion[], answers: string[]): string {
  const lines = questions.map((q, i) => {
    const answer = answers[i]?.trim()
    return answer ? `- [${q.header}] ${answer}` : `- [${q.header}]（用户跳过了这一问）`
  })
  return ['用户的回答：', ...lines].join('\n')
}

const DECLINED =
  '用户不想选，让你自己判断。按你认为最好的方案继续，' +
  '并在最终回复里明确写出你替他做了哪些假设。'

const CANCELLED =
  '用户没有回答（他主动关掉了提问，或者对话被停止了）。不要猜着往下做 —— 停下来等用户。'

const TOO_MANY =
  `这一轮已经问过 ${MAX_ASKS_PER_RUN} 次了，不能再问。` +
  '按你手头的信息选一个最合理的方案做下去，并在回复里写明你的假设。'

const ALREADY_PENDING =
  '已经有一个问题挂在界面上等用户回答了，不能同时问第二个。' +
  '先等那一个的结果，需要的话把几问合并成一次提问。'

export function createAskUserTool(deps: AskUserToolDeps): UnrealAgentTool<QuestionOutcome> {
  // 闸门状态挂在闭包上：一个工具实例对应一次运行（`createUnrealAgent` 每轮现造），
  // 所以「这一轮问过几次」天然随运行结束归零，不需要额外的清理点。
  let asked = 0
  let userCancelled = false

  return defineTool<typeof askUserInput, QuestionOutcome>({
    name: 'ask_user',
    namespace: 'host',
    description: DESCRIPTION,
    input: askUserInput,
    // 只是问一句，什么都不改 —— 走审批门会变成「为了弹一个问题先弹一个确认框」
    risk: 'safe',
    concurrency: 'sequential',
    execute: async (args, ctx) => {
      if (asked >= MAX_ASKS_PER_RUN) {
        return { text: TOO_MANY, isError: true }
      }
      if (hasPendingQuestion(deps.sessionId)) {
        return { text: ALREADY_PENDING, isError: true }
      }
      // 用户已经关掉过一张卡片：别再弹，直接告诉模型没人回答。
      // 报 isError 会让它以为工具坏了然后重试，这里要的是「停下来」。
      if (userCancelled) {
        return { text: CANCELLED, details: { action: 'cancel' }, terminate: true }
      }

      asked += 1
      const questions = args.questions as AskUserQuestion[]
      const outcome = await deps.request(
        { sessionId: deps.sessionId, toolCallId: ctx.toolCallId, questions },
        ctx.signal
      )

      if (outcome.action === 'accept') {
        return {
          text: formatAnswers(questions, outcome.answers ?? []),
          details: outcome
        }
      }

      if (outcome.action === 'decline') {
        return { text: DECLINED, details: outcome }
      }

      // cancel：会话被停止、超时、或者用户直接把卡片关了。
      // `terminate` 让本批工具跑完就收手 —— 没人在回答的时候继续自作主张干活，
      // 正是这个功能想避免的事。
      userCancelled = true
      return { text: CANCELLED, details: outcome, terminate: true }
    }
  })
}
