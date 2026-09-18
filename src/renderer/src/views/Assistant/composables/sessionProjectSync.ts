/**
 * 模型改了会话归属 → 侧边栏跟着变。
 *
 * ## 为什么挂在常驻布局上，不挂在助手页面里
 *
 * 助手路由没开 `meta.keepAlive`：用户切去看素材库那一刻整棵组件树就卸载了，
 * 而 agent 还在后台跑。归属是在**跑的过程中**改的（模型建完新工程之后），
 * 挂在页面里等于「用户正好在看助手页」才生效 —— 而他多半正在别处等结果。
 *
 * 同 `appAgentRunner` / `followUpDelivery` / `notificationActivation`，
 * 见 `layout/MainLayout.vue` 里那段注释。
 *
 * ## 为什么主进程不等回执
 *
 * 主进程那边改完执行流上的归属就直接发事件（见 `ipc/agentV3.ts` 的
 * `sessionProjectControl`）。这条只是让界面跟上，不是生效的前提 ——
 * 反过来等回执的话，没人监听时那次工具调用会挂住。
 */

import { onMounted, onUnmounted } from 'vue'

import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import type { ChatSessionProject } from '@renderer/store/modules/chatSessions'

export interface SessionProjectEvent {
  /**
   * **内核**会话 id（`agent-v3:*` 全部通道用的那个），不是界面这边的 `id`。
   *
   * 两者是两个不同的 uuid，见 store 里 `sessionByAgentSessionId` 的注释。
   * 拿它直接去 `setProject` 永远查不到那条会话 —— 而 `setProject` 查不到就
   * 静默 return，于是整条同步链路一声不响地什么都不做：工具报告「侧边栏已经
   * 跟着变了」，界面纹丝不动，用户下一条消息再把旧归属传下来，改动被抹掉。
   */
  sessionId: string
  /** `null` = 解除归属，和「从没定过」不是一回事，见 store 里 `clearProject` 的注释 */
  project: ChatSessionProject | null
}

/**
 * 把一条事件落到 store 上。
 *
 * 抽成纯函数是为了能直接测。这里有两处走错了都不会报错、只会静默失效：
 * 拿内核 id 当界面 id 用，以及 `null` 走了 `setProject` 而不是 `clearProject`
 * （后者的表现是用户明说「不归属任何工程」之后，下一条消息又被自动塞回去）。
 */
export function applySessionProjectEvent(
  event: SessionProjectEvent | undefined,
  store: {
    sessionByAgentSessionId: (agentSessionId: string) => { id: string } | null
    setProject: (id: string, project: ChatSessionProject | null) => void
    clearProject: (id: string) => void
  }
): void {
  const agentSessionId = event?.sessionId?.trim()
  if (!agentSessionId) return

  // 先把内核 id 翻成界面 id。翻不出来说明这条会话不在这个窗口里（已删、或别的窗口），
  // 什么都不做比拿一个查不到的 id 去写要好
  const id = store.sessionByAgentSessionId(agentSessionId)?.id
  if (!id) return

  if (event?.project?.projectName?.trim()) {
    store.setProject(id, event.project)
    return
  }
  store.clearProject(id)
}

/** 在常驻布局的 setup 里调一次 */
export function useSessionProjectSync(): void {
  const sessions = useChatSessionsStore()

  /*
   * `api.on` 把监听器包了一层再注册，**返回的才是真正挂上去的那个**。
   * 退订必须还它那一份 —— 还原来的函数等于什么都没退掉。
   */
  let handler: ((...args: unknown[]) => void) | undefined

  onMounted(() => {
    handler = window.api.on('agent-v3:session-project', (...args: unknown[]) =>
      applySessionProjectEvent(args[0] as SessionProjectEvent | undefined, sessions)
    ) as (...args: unknown[]) => void
  })
  onUnmounted(() => {
    if (handler) window.api.off('agent-v3:session-project', handler)
  })
}
