/**
 * 用户点了 agent 的系统通知 → 跳到发那条通知的会话。
 *
 * ## 为什么挂在常驻布局上
 *
 * 助手路由没开 keepAlive：用户切去看素材库，助手页就卸载了，而 agent 照样在跑，
 * 通知照样会弹。要是把这个监听写在助手页里，「通知能不能跳回去」就取决于用户
 * 离开时停在哪个页面 —— 而他多半正是因为切走了才需要这条通知。
 *
 * ## 为什么要反查
 *
 * 通知带的是**内核**会话 id（`agent-v3:*` 那套），界面上的标签页、路由、消息用的
 * 是另一个 id。拿内核 id 直接当路由参数会跳到一条空会话上，比不跳还糟。
 */

import { onScopeDispose } from 'vue'
import { isNavigationFailure, NavigationFailureType, useRouter, type Router } from 'vue-router'

import { agentNotificationsAPI } from '@renderer/api/agentNotifications'
import { chatSessionRoute } from '@renderer/common/chatRoute'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { usePendingApprovalsStore } from '@renderer/store/modules/pendingApprovals'
import { useTabsStore } from '@renderer/store/modules/tabs'
import type { NotificationActivatePayload } from '@core/shared/agentNotificationActivation'

/** 笔记本里那条私有对话的会话 id 前缀。见 NotebookDetail 挂 AssistantWelcome 的地方 */
const NOTEBOOK_CHAT_PREFIX = 'notebook-chat-'
/** 蓝图库 / 材质库详情页里那条对话的前缀。见 LibraryAIPanel 挂 AssistantWelcome 的地方 */
const BLUEPRINT_CHAT_PREFIX = 'library-chat-blueprint-'
const MATERIAL_CHAT_PREFIX = 'library-chat-material-'

/**
 * 这条会话该跳去哪。
 *
 * 页面内嵌的那几条对话单独走：它们是**那个页面的一部分**，被刻意排除在标签页和
 * 侧边栏之外（`chatSessions` 的 `listableSessions`）。按普通会话跳的话会把它拽成
 * 一个光秃秃的助手标签页 —— 没有来源面板、没有笔记编辑器、没有蓝图画布，
 * 而侧边栏又拒绝列出它，用户回不去。所以回它自己的页面。
 */
function routeForChatSession(
  chatSid: string,
  openTabPaths: string[]
): Parameters<Router['push']>[0] {
  if (chatSid.startsWith(NOTEBOOK_CHAT_PREFIX)) {
    return { name: 'NotebookDetail', params: { id: chatSid.slice(NOTEBOOK_CHAT_PREFIX.length) } }
  }
  if (chatSid.startsWith(BLUEPRINT_CHAT_PREFIX)) {
    return { name: 'BlueprintEditor', params: { id: chatSid.slice(BLUEPRINT_CHAT_PREFIX.length) } }
  }
  if (chatSid.startsWith(MATERIAL_CHAT_PREFIX)) {
    return { name: 'MaterialEditor', params: { id: chatSid.slice(MATERIAL_CHAT_PREFIX.length) } }
  }
  return chatSessionRoute(chatSid, openTabPaths)
}

export function useNotificationActivation(): void {
  const router = useRouter()
  const tabsStore = useTabsStore()
  const chatStore = useChatSessionsStore()
  const approvals = usePendingApprovalsStore()

  /*
   * 回话是主进程收通知的依据，所以只有**真跳到了**才算数。
   *
   * 认不出这条会话，或者跳到一半失败了（守卫抛错、目标 chunk 拉不下来），
   * 都得如实说没成 —— 主进程会把通知重新弹一条。谎报的话用户既没跳过去，
   * 手上那个入口也没了（系统在他点下去那一刻就把 toast 摘走了）。
   */
  function activate({ notificationKey, sessionId, toolCallId }: NotificationActivatePayload): void {
    const session = chatStore.sessionByAgentSessionId(sessionId)

    // 查不到就什么都不做：主进程已经把窗口拉到前台了，用户至少回到了盒子里。
    // 硬跳一个猜出来的会话，只会把他从正在看的东西上扯走
    if (!session) {
      reportSilently(notificationKey, false)
      return
    }

    // 他点的是**这一条**审批。确认框默认读队首，不指名的话另一条会话正卡着的
    // 确认框会挡在前面，而那不是他来答的东西
    if (toolCallId) approvals.focus(toolCallId)

    void router
      .push(
        routeForChatSession(
          session.id,
          tabsStore.historyTabs.map((tab) => tab.path)
        )
      )
      .then((failure) => {
        /*
         * **没跳成不一定是 reject。** `push` 只在守卫抛错、目标 chunk 拉不下来
         * 时才 reject；被中止（守卫 `next(false)`）和被后来的导航顶掉都是正常
         * resolve 的，只带回一个 NavigationFailure。
         *
         * 「顶掉」现在就够得着：用户点了通知，紧接着自己点了侧边栏 —— 我们这次
         * 跳输了，可要是照 `.then` 就当跳到了，主进程会把通知收掉，而他并不在
         * 那条会话上。
         *
         * （守卫**改道**不在此列：vue-router 会跟着改道跳完再 resolve，
         * `NavigationFailureType` 里压根没有 redirected 这一项。）
         *
         * 「已经在这条路由上」那种 failure 算到了 —— 他要看的东西就在眼前。
         */
        const arrived = !failure || isNavigationFailure(failure, NavigationFailureType.duplicated)
        reportSilently(notificationKey, arrived)
      })
      .catch((error) => {
        console.error('[NotificationActivation] 跳转失败', error)
        reportSilently(notificationKey, false)
      })
  }

  /*
   * 推送可能落空 —— 用户点通知那一刻这个布局不一定挂着（`/404`、首启语言门、
   * 渲染进程正在重载）。主进程为此存了一份，挂上来先问一次。
   * 正常情况下推送已经送到并顺手清掉了存档，这里取到的是 null。
   */
  void takePendingSilently().then((pendingPayload) => {
    if (pendingPayload) activate(pendingPayload)
  })

  const dispose = agentNotificationsAPI.onActivated((payload) => {
    activate(payload)
    // 把主进程存的那份销掉，否则下次这个布局重建时会照着旧的再跳一次
    void takePendingSilently()
  })

  onScopeDispose(dispose)
}

/**
 * 这两条 IPC 都可能因为「处理器还没挂上 / 已经摘掉」而 reject
 * （`startAgentNotifications` 排在 `createWindow()` 后面）。它们都只是锦上添花，
 * 失败了不该变成一条没人管的 promise rejection —— 咽掉，记一行就够。
 */
function takePendingSilently(): Promise<NotificationActivatePayload | null> {
  return agentNotificationsAPI.takePending().catch((error) => {
    console.warn('[NotificationActivation] 取回待处理的通知失败', error)
    return null
  })
}

function reportSilently(notificationKey: string, handled: boolean): void {
  void agentNotificationsAPI.reportActivation(notificationKey, handled).catch((error) => {
    console.warn('[NotificationActivation] 回报处理结果失败', error)
  })
}
