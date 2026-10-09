/**
 * 独立对话窗口相关的两条路由规矩。
 *
 * 1. **主窗口**里要打开的对话正开在独立窗口里 → 不在主窗口开标签，把那个窗口提上来。
 *    侧边栏、系统通知、对话里的跳转都走路由，拦在这一处就全拦住了。
 * 2. **独立窗口**里要去别的页面（资产库定位、偏好设置、别的对话）→ 交给主窗口去开。
 *    独立窗口只放它那一条对话；在这里打开主界面的页面，等于在对话窗口里塞进第二套主界面。
 *
 * 判定是纯函数，好单测；接线在 `router/index.ts`。
 */

import type { NavigationGuard } from 'vue-router'

import { chatWindowAPI, chatWindowSid, isChatWindow } from '@renderer/api/chatWindow'
import { isDetachedChat } from '@renderer/utils/detachedChats'

export type ChatWindowNavigation =
  | { kind: 'pass' }
  | { kind: 'stay' }
  | { kind: 'focus-detached'; sid: string }
  | { kind: 'open-in-main'; path: string }

interface NavigationTarget {
  path: string
  fullPath: string
  name?: string | symbol | null
  query: Record<string, unknown>
}

const CHAT_WINDOW_PATH = '/chat-window'

function sidOf(target: NavigationTarget): string {
  const sid = target.query.sid
  return typeof sid === 'string' ? sid.trim() : ''
}

export function decideChatWindowNavigation(
  to: NavigationTarget,
  context: { inChatWindow: boolean; ownSid: string; isDetached: (sid: string) => boolean }
): ChatWindowNavigation {
  if (context.inChatWindow) {
    if (to.path === CHAT_WINDOW_PATH) return { kind: 'pass' }
    // 「打开我自己这条」：已经开着了，原地不动
    if (to.name === 'AssistantWelcome' && sidOf(to) === context.ownSid) return { kind: 'stay' }
    return { kind: 'open-in-main', path: to.fullPath }
  }

  if (to.name === 'AssistantWelcome') {
    const sid = sidOf(to)
    if (sid && context.isDetached(sid)) return { kind: 'focus-detached', sid }
  }
  return { kind: 'pass' }
}

export const chatWindowGuard: NavigationGuard = (to, _from, next) => {
  const decision = decideChatWindowNavigation(to, {
    inChatWindow: isChatWindow(),
    ownSid: chatWindowSid(),
    isDetached: isDetachedChat
  })
  switch (decision.kind) {
    case 'pass':
      next()
      return
    case 'stay':
      next(false)
      return
    case 'focus-detached':
      void chatWindowAPI.open(decision.sid)
      next(false)
      return
    case 'open-in-main':
      chatWindowAPI.openInMain(decision.path)
      next(false)
      return
  }
}
