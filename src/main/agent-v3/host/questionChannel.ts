/**
 * 「反问用户」的 IPC 往返。
 *
 * 主进程发 `agent-v3:question-required`，渲染层在时间线上长出一张选项卡片，
 * 用户点完经 `agent-v3:question-reply` 回传。这期间 agent 阻塞在 `ask_user`
 * 工具的 execute 里，但**不中断** —— 用户可以同时 steer 插话改方向。
 *
 * ## 和审批（approvalChannel.ts）的关系
 *
 * 骨架是同一套（toolCallId 匹配、刷新补发），刻意没有合并：
 *
 *   - 审批是**拦截**，问的是「这一步能不能做」，默认答案是不能，所以它可以有超时 ——
 *     五分钟没人理就按拒绝，那是**安全**的一侧，什么都没发生。
 *   - 提问是**求助**，问的是「你到底想要什么」，**没有默认答案**。超时按什么处理都是
 *     替不在场的人做主：按取消是替他决定「这事不做了」，按「你自己定」更糟。
 *
 * 所以提问**没有超时**，见下。
 *
 * ## 为什么提问不设超时
 *
 * 这里原来有一个 30 分钟的兜底，到点按 `cancel`。取消掉了：
 * 用户没回答不代表他放弃，只代表他还没回来。宁可一直卡着等，也不要替他
 * 做关键选择、或者替他放弃 —— 后者在目标模式下尤其糟，一次超时会让整条
 * 目标线索在用户毫不知情的情况下结束掉。
 *
 * 卡着不等于卡死，**始终有三条出路，且都由人或环境明确触发**：
 *
 *   1. 用户回答（accept / decline / 主动关掉卡片按 cancel）；
 *   2. 用户按停止 / 删掉会话 → `signal` abort；
 *   3. 拥有这张卡片的窗口被销毁 → 见 `onSenderGone`。
 *
 * ## 为什么是三态而不是两态
 *
 * MCP 的 elicitation 规范强制 accept / decline / cancel 三态，理由是
 * 「用户说不」和「用户把窗关了」不是一回事。我们照办：
 *
 *   - `accept`  用户选了 → 把选择喂回模型
 *   - `decline` 用户点了「你自己定」→ 让模型带着假设继续
 *   - `cancel`  会话被停止 / 窗口没了 / 应用重启 → 让模型**停下来**，不要猜着往下做
 *
 * 把后两者揉成一个的后果很具体：用户按了停止，agent 反而收到一句
 * 「你自己定」然后继续埋头干活。
 */

import { ipcMain, type WebContents } from 'electron'

import type {
  AgentQuestion,
  AgentQuestionAction,
  AgentQuestionOption
} from '../../../shared/agentQuestion'

import { notifyAgentRun } from './runObserver'

const REPLY_CHANNEL = 'agent-v3:question-reply'

/** 用户对一次提问的处置。语义见文件头 */
export type QuestionAction = AgentQuestionAction

/** 一问及其选项。形状定义在 `shared/agentQuestion.ts`，三边共用一份 */
export type AskUserQuestion = AgentQuestion
export type AskUserOption = AgentQuestionOption

/** 发给渲染层的那条提问，原样留一份好补发 */
export interface QuestionPayload {
  sessionId: string
  toolCallId: string
  questions: AskUserQuestion[]
}

export interface QuestionRequest {
  sessionId: string
  toolCallId: string
  questions: AskUserQuestion[]
}

export interface QuestionOutcome {
  action: QuestionAction
  /**
   * 与 `questions` **同序**的回答，空串表示这一问没选。
   *
   * 不用 `Record<header, answer>`：header 只有 12 个字符，模型完全可能在一次
   * 提问里给出两个一样的 header，那时对象键会互相覆盖，而用户在界面上明明
   * 答了两问。下标对齐不会有这个问题。
   */
  answers?: string[]
}

interface ReplyPayload {
  toolCallId: string
  action: QuestionAction
  answers?: string[]
}

/**
 * 还等着用户回答的提问：toolCallId -> 请求本身。
 *
 * 和审批同理 —— 刷新页面只重启了界面，卡片和它的状态跟着没了，而主进程这边
 * 还阻塞在工具里等回复。而提问**没有超时**，不补发的话它会一直等下去，
 * 用户看到的是「刷新之后 agent 卡住不动」，而他从头到尾没看见过那张卡片。
 */
const pendingQuestions = new Map<string, { senderId: number; payload: QuestionPayload }>()

/**
 * 把这个窗口名下、属于这几条会话的待回答提问重新发一遍。
 *
 * 按 senderId 过滤：提问只对**发起它的那个窗口**有意义。返回补发了几条。
 */
export function resendPendingQuestions(sender: WebContents, sessionIds: readonly string[]): number {
  if (sender.isDestroyed() || sessionIds.length === 0) return 0

  const wanted = new Set(sessionIds)
  let sent = 0
  for (const entry of pendingQuestions.values()) {
    if (entry.senderId !== sender.id || !wanted.has(entry.payload.sessionId)) continue
    sender.send('agent-v3:question-required', entry.payload)
    sent += 1
  }
  return sent
}

/** 这条会话现在有没有问题挂着等人答。工具用它挡住并发提问 */
export function hasPendingQuestion(sessionId: string): boolean {
  for (const entry of pendingQuestions.values()) {
    if (entry.payload.sessionId === sessionId) return true
  }
  return false
}

/**
 * 构造 `ask_user` 工具用的 `requestQuestion`。
 *
 * 用 toolCallId 匹配而不是 `ipcMain.once` —— 和审批同一个理由：
 * `toolExecution: 'parallel'` 下可能同时有别的往返在等，once 会串线。
 */
export function createQuestionRequester(
  sender: WebContents
): (req: QuestionRequest, signal?: AbortSignal) => Promise<QuestionOutcome> {
  return (req, signal) =>
    new Promise<QuestionOutcome>((resolve) => {
      if (sender.isDestroyed()) {
        resolve({ action: 'cancel' })
        return
      }

      let settled = false
      const finish = (outcome: QuestionOutcome): void => {
        if (settled) return
        settled = true
        ipcMain.removeListener(REPLY_CHANNEL, handler)
        signal?.removeEventListener('abort', onAbort)
        sender.off('destroyed', onSenderGone)
        pendingQuestions.delete(req.toolCallId)
        // 语音前台可能正把这一问念给用户听。不说一声的话，用户在界面上点完了，
        // 语音那边还在等一个已经不存在的答案
        notifyAgentRun({
          type: 'question-settled',
          sessionId: req.sessionId,
          toolCallId: req.toolCallId
        })
        resolve(outcome)
      }

      const handler = (_event: Electron.IpcMainEvent, payload: ReplyPayload): void => {
        // 只处理本次调用的回复，其他并发往返的回复留给它们自己的监听器
        if (payload?.toolCallId !== req.toolCallId) return
        const action: QuestionAction =
          payload.action === 'accept' || payload.action === 'decline' ? payload.action : 'cancel'
        finish({
          action,
          ...(action === 'accept' && Array.isArray(payload.answers)
            ? { answers: payload.answers.map((a) => (typeof a === 'string' ? a : '')) }
            : {})
        })
      }

      // 用户按停止 / 删除会话：不是「他拒绝回答」，是这一轮整个不作数了
      const onAbort = (): void => finish({ action: 'cancel' })

      /**
       * 拿着这张卡片的窗口没了 —— 这是**没有超时之后唯一还会卡死的路径**。
       *
       * 应用在 `window-all-closed` 时不退出，留在托盘（见 `main/index.ts`）。
       * 所以关掉窗口之后主进程还活着，而这条提问再也没人能答：`resendPendingQuestions`
       * 按 `senderId` 过滤，重开窗口是一个新的 WebContents、新的 id，补发也认不出它。
       * 不管的话这次运行会一直挂着，攥着资产锁，这条会话也永远发不出下一条消息。
       *
       * 按 `cancel` 收掉不违背「不替用户做主」：能让他回答的那个界面已经不存在了，
       * 这不是替他决定，是如实报告没人能答。
       */
      const onSenderGone = (): void => {
        console.warn(`[AgentV3] 提问所属窗口已销毁，按取消处理: ${req.toolCallId}`)
        finish({ action: 'cancel' })
      }

      ipcMain.on(REPLY_CHANNEL, handler)
      signal?.addEventListener('abort', onAbort, { once: true })
      sender.once('destroyed', onSenderGone)

      const payload: QuestionPayload = {
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        questions: req.questions
      }
      pendingQuestions.set(req.toolCallId, { senderId: sender.id, payload })
      sender.send('agent-v3:question-required', payload)
      // 这条不走 eventBridge（它是工具执行流里直接发的），所以旁路要单独喂一次。
      // 漏掉它，语音就没法把「Agent 在问你」念给用户听 —— 而用户此刻可能正没看屏幕
      notifyAgentRun({
        type: 'question',
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        questions: req.questions
      })
    })
}
