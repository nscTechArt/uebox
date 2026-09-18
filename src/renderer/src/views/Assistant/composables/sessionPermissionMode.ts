/**
 * 权限档位是**每条会话一份**的。
 *
 * 曾经它是一个全局设置：A 会话调成只读、切到 B 调成完全访问，再切回 A ——
 * A 也显示成完全访问了，而且真的按完全访问跑。用户在 A 上做的那个「别乱动」
 * 的决定，被他在 B 上的选择悄悄推翻了，界面上没有任何地方提示过这件事。
 *
 * 现在分成两件事：
 * - **生效的那一份**存在会话上（`chatSessions.permissionModeById`），谁也改不了别人的；
 * - **新会话从哪一档起步**跟着用户上一次的选择走（`aiConfig.agentPermissionMode`）——
 *   他上次调成了完全访问，下次新开一条也是完全访问，不必每次重调。
 *
 * 打开一条会话时会把当时的起步档位**盖在这条会话上**（`ensurePermissionMode`）。
 * 不盖的话它会一直跟着「上一次的选择」飘：在别的标签页里调一次档位，
 * 这条从没动过的会话会跟着变 —— 那还是同一个 bug 的另一种形状。
 */

import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { useChatSessionsStore, type ChatPermissionMode } from '@renderer/store/modules/chatSessions'

export type { ChatPermissionMode }

/** 这条会话此刻实际生效的档位。必须在有活跃 pinia 的地方调用 */
export function resolvePermissionMode(chatSid: string): ChatPermissionMode {
  const stored = useChatSessionsStore().getPermissionMode(chatSid)
  return stored ?? useAIConfigStore().agentPermissionMode
}

/**
 * 改这条会话的档位，并记成「下次新会话的起步档位」。
 *
 * 记这一笔只影响**以后新开的**会话：已经打开过的会话都盖过章了（见文件头），
 * 不会被这次选择带着走。
 */
export function setPermissionMode(chatSid: string, mode: ChatPermissionMode): void {
  useChatSessionsStore().setPermissionMode(chatSid, mode)
  useAIConfigStore().setAgentPermissionMode(mode)
}

/** 打开会话时盖章：没自己的档位就把当前的起步档位钉上去 */
export function ensurePermissionMode(chatSid: string): ChatPermissionMode {
  const chatStore = useChatSessionsStore()
  const stored = chatStore.getPermissionMode(chatSid)
  if (stored) return stored

  const inherited = useAIConfigStore().agentPermissionMode
  chatStore.setPermissionMode(chatSid, inherited)
  return inherited
}

export function isReadOnlyMode(mode: ChatPermissionMode): boolean {
  return mode === 'read-only'
}

/**
 * 翻译成内核的审批档位。
 *
 * 只读那一档在内核里没有对应物 —— 它是靠**不给写工具**实现的（`mode: 'ask'`
 * 的工具清单里根本没有写操作）。这里按最严的一档算：万一有哪条路径只看审批档位
 * 不看工具清单，也该是「每步都问」而不是「随便放行」。
 */
export function toApprovalMode(mode: ChatPermissionMode): AgentV3ApprovalMode {
  return mode === 'read-only' ? 'ask' : mode
}
