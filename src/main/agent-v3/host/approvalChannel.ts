/**
 * 审批的 IPC 往返。
 *
 * 主进程发 `agent-v3:approval-required`，渲染层弹窗，用户点完经
 * `agent-v3:approval-reply` 回传。这期间 agent 阻塞在 `beforeToolCall` 里，
 * 但**不中断** —— 用户可以同时 steer 插话改方向。
 */

import { ipcMain, type WebContents } from 'electron'

import type { ApprovalRequest, ApprovalVerdict } from '../core/approval'

import { notifyAgentRun } from './runObserver'

const REPLY_CHANNEL = 'agent-v3:approval-reply'

/**
 * 审批超时。
 *
 * 超时按**拒绝**处理，不是放行 —— 用户没在看屏幕时，默认不该让 agent
 * 自己批准一个需要人确认的操作。
 */
const APPROVAL_TIMEOUT_MS = 5 * 60_000

interface ReplyPayload {
  toolCallId: string
  verdict: ApprovalVerdict
}

/** 发给渲染层的那条审批请求，原样留一份好补发 */
interface ApprovalPayload {
  sessionId: string
  toolCallId: string
  toolName: string
  namespace: string
  risk: string
  args: unknown
  /** false 时界面不给「本次会话都允许」，见 `core/approval.ts` */
  allowAlways: boolean
}

/**
 * 还等着用户点的审批：toolCallId -> 请求本身。
 *
 * 存这一份是为了**刷新页面之后能补发**。agent 跑在主进程，刷新只重启了界面 ——
 * 但弹窗和它的状态是渲染层的，一起没了，而主进程这边还阻塞在 `beforeToolCall`
 * 里等回复。不补发的话它会一直等到 5 分钟超时，然后按拒绝处理：用户看到的是
 * 「刷新之后 agent 卡住不动，最后说这一步被拒绝了」，而他从头到尾没点过拒绝。
 */
const pendingApprovals = new Map<string, { senderId: number; payload: ApprovalPayload }>()

/**
 * 把这个窗口名下、属于这几条会话的待审批重新发一遍。
 *
 * 按 senderId 过滤：审批只对**发起它的那个窗口**有意义，别的窗口收到会弹出
 * 一个它根本没在跑的操作的确认框。返回补发了几条，调用方用来写日志。
 */
export function resendPendingApprovals(sender: WebContents, sessionIds: readonly string[]): number {
  if (sender.isDestroyed() || sessionIds.length === 0) return 0

  const wanted = new Set(sessionIds)
  let sent = 0
  for (const entry of pendingApprovals.values()) {
    if (entry.senderId !== sender.id || !wanted.has(entry.payload.sessionId)) continue
    sender.send('agent-v3:approval-required', entry.payload)
    sent += 1
  }
  return sent
}

/**
 * 构造发给 `createUnrealAgent` 的 `requestApproval`。
 *
 * 用 toolCallId 匹配而不是 ipcMain.once —— `toolExecution: 'parallel'` 下
 * 可能同时有多个审批在等，once 会串线。V2 的 token 刷新握手就踩过这个坑。
 */
export function createApprovalRequester(
  sender: WebContents
): (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalVerdict> {
  return (req, signal) =>
    new Promise<ApprovalVerdict>((resolve) => {
      if (sender.isDestroyed()) {
        resolve('reject')
        return
      }

      let settled = false
      const finish = (verdict: ApprovalVerdict): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ipcMain.removeListener(REPLY_CHANNEL, handler)
        signal?.removeEventListener('abort', onAbort)
        pendingApprovals.delete(req.toolCallId)
        // 语音前台可能正把这个确认念给用户听。不说一声的话，用户在界面上点完了，
        // 语音那边还在等一个已经不存在的确认
        notifyAgentRun({
          type: 'approval-settled',
          sessionId: req.sessionId,
          toolCallId: req.toolCallId
        })
        // 反过来也一样：用户口头批了（语音那条路直接回传），屏幕上那个确认框
        // 还开着，他再点一下等于对一个已经不存在的审批表态。告诉界面收掉它
        if (!sender.isDestroyed()) {
          sender.send('agent-v3:approval-settled', {
            sessionId: req.sessionId,
            toolCallId: req.toolCallId,
            verdict
          })
        }
        resolve(verdict)
      }

      const handler = (_event: Electron.IpcMainEvent, payload: ReplyPayload): void => {
        // 只处理本次调用的回复，其他并发审批的回复留给它们自己的监听器
        if (payload?.toolCallId !== req.toolCallId) return
        finish(payload.verdict)
      }

      const onAbort = (): void => finish('reject')

      const timer = setTimeout(() => {
        console.warn(`[AgentV3] 审批超时（${APPROVAL_TIMEOUT_MS}ms），按拒绝处理: ${req.toolName}`)
        finish('reject')
      }, APPROVAL_TIMEOUT_MS)

      ipcMain.on(REPLY_CHANNEL, handler)
      signal?.addEventListener('abort', onAbort, { once: true })

      const payload: ApprovalPayload = {
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        namespace: req.namespace,
        risk: req.risk,
        args: req.args,
        allowAlways: req.allowAlways
      }
      pendingApprovals.set(req.toolCallId, { senderId: sender.id, payload })
      sender.send('agent-v3:approval-required', payload)
      /*
       * 这条也不走 eventBridge（它是 `beforeToolCall` 里直接发的），旁路要单独喂。
       *
       * 漏掉它的后果比漏掉反问更重：反问超时按取消算，审批**超时按拒绝算**，
       * 而且要等五分钟。用户戴着耳机没看屏幕时，那五分钟里他完全不知道
       * 有个确认框在等他，最后只听说「这一步被拒绝了」。
       */
      notifyAgentRun({
        type: 'approval',
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        risk: req.risk,
        allowAlways: req.allowAlways
      })
    })
}
