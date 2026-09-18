import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { agentV3API } from '@renderer/api/agentV3'

/**
 * 一条还等着用户表态的审批。
 *
 * 字段就是主进程 `agent-v3:approval-required` 发过来的原样（见
 * `main/agent-v3/host/approvalChannel.ts`）—— 怎么显示是界面的事，
 * 这里只负责把它**存活着**。
 */
export interface PendingApproval {
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
 * 待审批队列。
 *
 * ## 为什么必须是 store 而不是组件里的 ref
 *
 * 确认框长在助手页的 `ChatLog` 里，而助手页**没开 keep-alive**：切到别的标签页
 * 那一刻整棵组件树就卸载了，`pendingAction` 这个组件内的 ref 跟着没。回来时组件
 * 重新挂载，状态是空的 —— 但主进程那边还阻塞在 `beforeToolCall` 里等回复，
 * 于是一路等到五分钟超时、按拒绝处理。用户看到的是「切了个页面回来，确认框
 * 没了，只能干等」，而他从头到尾没点过任何按钮。
 *
 * 同样的道理，审批在用户**不在助手页**的时候到达也不能丢：监听器挂在全局
 * 分发器上（`initAgentEventDispatcher`），队列存在这里，组件只是它的一个视图。
 *
 * ## 为什么是队列而不是一条
 *
 * 工具可以并行执行（`toolExecution: 'parallel'`），同一时刻可能有多条审批在等。
 * 原来后到的会**盖掉**前一条，被盖掉的那条同样只能等超时。
 */
export const usePendingApprovalsStore = defineStore('pending-approvals', () => {
  /** 先到先答。不做持久化：主进程才是这件事的真相，刷新后由 reattach 补发 */
  const queue = ref<PendingApproval[]>([])

  /**
   * 用户指名要答的那一条（点通知点进来的）。
   *
   * **存号而不是把队列重排。** 重排要求那条已经在队里，而最需要它的场合恰恰
   * 是队列还空着：点通知时界面没挂载（刷新、`/404`、语言门），主进程存的那条
   * 激活要等布局挂上来才取回，而待审批本身不落盘、要等 `reattach` 补发 ——
   * 补发一定在取回之后。存号就没有先后问题：谁先到都行，队列填上了自然生效。
   */
  const focusedId = ref('')

  /** 当前该让用户看的那一条。用户指名的优先，其余先到先答 */
  const current = computed<PendingApproval | null>(() => {
    const named = focusedId.value
      ? queue.value.find((item) => item.toolCallId === focusedId.value)
      : undefined
    return named ?? queue.value[0] ?? null
  })

  /**
   * 收下一条待审批。
   *
   * 按 toolCallId 去重：刷新后 `resendPendingApprovals` 会把同一条再发一遍，
   * 不去重的话界面上会排出两张一模一样的确认框。
   */
  function enqueue(request: PendingApproval): void {
    if (!request?.toolCallId) return
    if (queue.value.some((item) => item.toolCallId === request.toolCallId)) return
    queue.value.push(request)
  }

  /**
   * 用户指名要答这一条，确认框先显示它。
   *
   * 「先到先答」在用户自己选了的时候不成立：他点的是**某条通知**，而两条会话
   * 可以同时卡在审批上。不认这个号的话他跳过去看到的是另一条会话的破坏性操作
   * —— 要么批错东西，要么他要答的那条在五分钟后超时按拒绝算。
   *
   * 队列里现在有没有这条都照记：它可能还没补发过来，见 `focusedId`。
   */
  function focus(toolCallId: string): void {
    focusedId.value = toolCallId
  }

  /** 这条审批已经落定了（用户口头批的、被中止的、或者超时），把卡片收掉 */
  function settle(toolCallId: string): void {
    // 指名的这条答完了，指名就该失效 —— 不清的话它会一直压着后面排队的
    if (focusedId.value === toolCallId) focusedId.value = ''
    const index = queue.value.findIndex((item) => item.toolCallId === toolCallId)
    if (index >= 0) queue.value.splice(index, 1)
  }

  /**
   * 用户点了按钮：先出队再回传。
   *
   * 队列里没有这条就什么都不做 —— 它已经在别处落定了，再发一次等于对一个
   * 不存在的审批表态。
   */
  function reply(toolCallId: string, verdict: AgentV3ApprovalVerdict): void {
    if (!queue.value.some((item) => item.toolCallId === toolCallId)) return
    settle(toolCallId)
    agentV3API.replyApproval(toolCallId, verdict)
  }

  /**
   * 全部按拒绝回传。
   *
   * 窗口要关了、会话被重置 —— 界面这边不会再有人来点了，但主进程还阻塞在
   * `beforeToolCall` 里。不给个交代它就干等到五分钟超时。
   */
  function rejectAll(): void {
    for (const item of [...queue.value]) {
      reply(item.toolCallId, 'reject')
    }
  }

  return { queue, current, enqueue, focus, settle, reply, rejectAll }
})
