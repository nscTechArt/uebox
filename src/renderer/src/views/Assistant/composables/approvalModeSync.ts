/**
 * 审批档位 → 主进程的实时同步（全局单例）。
 *
 * 档位存在渲染层，真正用它的却是主进程的审批门。原来这个值只在发消息时随
 * execute 带下去一次，于是「跑到一半改档位」在本轮完全不算数 —— 而用户恰恰
 * 是被确认框拦住的那一刻才会去改它，等于这个开关在最需要它的时候是坏的。
 * 主进程那边的审批门现在每次工具调用现读档位，这里负责把改动送过去。
 *
 * **按会话送**：档位是每条会话一份的（见 sessionPermissionMode.ts），
 * 主进程那张表也是按内核 sessionId 存的。这里盯住「每条内核会话此刻该是哪一档」
 * 这张表，只把变了的那几条送下去。
 *
 * 盯这张表、而不是挂在输入框那个下拉的点击回调上：会话的档位不止一处会变
 * （输入框那个四档下拉、打开会话时的盖章、还没盖过章的会话跟着起步档位走），
 * 挂在回调上迟早漏掉一处。
 */

import { computed, watch } from 'vue'

import { agentV3API } from '@/api/agentV3'
import { useAIConfigStore } from '@/store/modules/aiConfig'
import { useChatSessionsStore } from '@/store/modules/chatSessions'
import { toApprovalMode } from './sessionPermissionMode'

let installed = false
type LivePermission = { approvalMode: AgentV3ApprovalMode; mode: 'agent' | 'ask' }

/** 只装一次。必须在 `app.use(pinia)` 之后调用 —— 这里要立刻拿到 store */
export function initApprovalModeSync(): void {
  if (installed) return
  installed = true

  const chatStore = useChatSessionsStore()
  const aiConfigStore = useAIConfigStore()

  /** 内核 sessionId → 此刻该用的审批档位。没起过内核会话的对话不在表里 */
  const modeByAgentSession = computed<Record<string, LivePermission>>(() => {
    const result: Record<string, LivePermission> = {}
    for (const session of chatStore.sessions) {
      const agentSessionId = session.agentSessionId
      if (!agentSessionId) continue

      const mode = chatStore.getPermissionMode(session.id) ?? aiConfigStore.agentPermissionMode
      // 只读是独立约束，不能折叠为 ask，否则旧授权仍然能放行写工具。
      result[agentSessionId] = {
        approvalMode: toApprovalMode(mode),
        mode: mode === 'read-only' ? 'ask' : 'agent'
      }
    }
    return result
  })

  /**
   * 已经送下去的那一份。
   *
   * 装的时候先照现状填满：主进程会在 execute 时自己收到档位，这里只负责
   * 「之后的改动」。不填的话第一次有人动档位，会连带把满仓库的历史会话
   * 全部推一遍 IPC。
   */
  const sent = new Map<string, LivePermission>(Object.entries(modeByAgentSession.value))

  watch(modeByAgentSession, (next) => {
    for (const [sessionId, mode] of Object.entries(next)) {
      const previous = sent.get(sessionId)
      if (previous?.mode === mode.mode && previous.approvalMode === mode.approvalMode) continue

      sent.set(sessionId, mode)
      // 送不到不该影响用户的操作：档位已经存进会话了，下一条消息照样会带下去。
      // 失去的只是「本轮立刻生效」这一件事，而那本来就是额外赚的。
      void agentV3API
        .setApprovalMode(sessionId, mode.approvalMode, mode.mode)
        .catch((error: unknown) => {
          sent.delete(sessionId)
          console.warn('[审批档位] 同步到主进程失败，本轮仍按旧档位执行:', error)
        })
    }
  })
}

/** 只给测试用：让下一次 init 重新装一遍 */
export function resetApprovalModeSyncForTest(): void {
  installed = false
}
