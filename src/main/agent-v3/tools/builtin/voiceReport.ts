/**
 * `voice_report` —— 把进度念给正在听的用户。
 *
 * ## 为什么是工具，不是「最后一行加个标记」
 *
 * 上一版让 Agent 在回复末尾写一行「【语音】…」，任务表跑完再抠出来念。两个毛病：
 * 那一行长在屏幕上的回复里，看着别扭；而且**只有做完那一次**能说话 ——
 * 一件长活跑三分钟，中间用户什么都听不到。
 *
 * 换成工具之后，Agent 想什么时候汇报就什么时候汇报：做到一个阶段报一次、
 * 卡住了报一次、做完了报一次。每次都带状态，任务表按状态决定念的优先级、
 * 以及做完那次要不要再补一句。这就是 Codex 那套「后台模型先产出一句适合口头说的结果」
 * 的落地：说什么由干活的模型定，它最清楚做到哪了。
 *
 * ## 谁拿得到
 *
 * 只有**语音派的活**（`ipc/agentV3.ts` 按任务表判断）。用户在界面上打字跑的运行
 * 没人在听，给了这个工具模型只会白调。子 agent 也不给：它的进度该写进返回文本，
 * 由父 agent 决定要不要说。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'

export type VoiceReportStatus = 'running' | 'done' | 'blocked'

export interface VoiceReport {
  status: VoiceReportStatus
  message: string
}

/**
 * 中途汇报念出来的上限。按每秒四个字算，80 字是二十秒 —— 一条进度能忍的上限。
 *
 * 中途和收尾**分两个额度**，因为这两句话要交代的事不一样：进度只回答「做到哪了」，
 * 收尾还要回答「接下来呢」。
 */
export const MAX_VOICE_REPORT_CHARS = 80

/**
 * 收尾那一次的上限，宽出一倍。
 *
 * 真机上压得太狠：Agent 屏幕上写的是「…搬完了。下一步建议：打开 XX 确认插件和资产
 * 都正常，要我现在帮你打开吗？」，念出来只剩「搬完了：三个插件和角色资产都进了新工程」。
 * 用户没看屏幕，那句被压掉他就不知道接下来该说什么 —— 而**这正是语音这条线唯一的出口**。
 * 一句结果 + 一句下一步，60 字装不下。
 */
export const MAX_FINAL_REPORT_CHARS = 160

const voiceReportInput = z
  .object({
    status: z
      .enum(['running', 'done', 'blocked'])
      .describe(
        'running：还在做，这是中途进度。done：这件事做完了 —— 每件活收尾前必须用它报一次。' +
          'blocked：做不下去了，需要用户做点什么（开工程、给路径）或者做决定'
      ),
    message: z
      .string()
      .min(1)
      .max(MAX_FINAL_REPORT_CHARS)
      .describe(
        '念给用户听的口语。中途进度一句话、不超过 60 字；收尾（done）可以两三句、不超过 120 字，' +
          '把结果和下一步都说清楚。别放路径、代码、markdown、工具名 —— 这句话是逐字念出来的'
      )
  })
  .superRefine((value, ctx) => {
    // 收尾那次要多说一句下一步，中途的不给这个额度：进度报成一段话就是实况解说
    if (value.status === 'done' || value.message.length <= MAX_VOICE_REPORT_CHARS) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message'],
      message: `中途汇报最多 ${MAX_VOICE_REPORT_CHARS} 字，说一句「做到哪了」就够。要说结果和下一步请用 status=done。`
    })
  })

const DESCRIPTION = [
  '把进度念给用户听。这件活是用户用语音派的，他多半没看屏幕，只能靠你说。',
  '',
  '什么时候用：',
  '- 做完一个阶段（找到了工程、蓝图改好了、开始编译）：status=running，一句话说做到哪了。',
  '- 做完了：status=done，**每件活收尾前必须报一次**，不报用户听不到结果。',
  '- 做不下去、要用户做点什么或做决定：status=blocked，说清要他干什么。',
  '',
  '怎么写：口语，像跟人说话。别念路径、代码、markdown、工具名。',
  '- 中途（running）：一句，不超过 60 字。别太密 —— 每个工具调用都报一次就是碎碎念，按阶段报。',
  '- 收尾（done）：可以两三句，不超过 120 字。除了结果，**你写在最终回复里的下一步建议、',
  '  以及要问用户的那句（「要我现在帮你打开吗」）也要说出来** —— 用户没看屏幕，',
  '  这一句是他唯一知道「接下来该说什么」的地方。省掉它等于把话说了一半。',
  '',
  '这个工具只管念，不改任何东西；念完接着干你的活。'
].join('\n')

export interface VoiceReportToolDeps {
  sessionId: string
  /** 交给任务表去念。同步的：念的时机和优先级那边定，工具不等 */
  report: (report: VoiceReport) => void
}

export function createVoiceReportTool(deps: VoiceReportToolDeps): UnrealAgentTool<VoiceReport> {
  return defineTool<typeof voiceReportInput, VoiceReport>({
    name: 'voice_report',
    namespace: 'host',
    description: DESCRIPTION,
    input: voiceReportInput,
    // 只是念一句，什么都不改 —— 走审批门会变成「为了报个进度先弹个确认框」
    risk: 'safe',
    concurrency: 'sequential',
    execute: async (args) => {
      const report: VoiceReport = { status: args.status, message: args.message.trim() }
      deps.report(report)
      return {
        text:
          report.status === 'done'
            ? '已经念给用户听了。这件事到此为止，把最终回复写完就行，不用再报。'
            : '已经念给用户听了，接着做。',
        details: report
      }
    }
  })
}
