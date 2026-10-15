/**
 * 把一件事交给盒子自己的 AI：新建一条对话、发出去、把用户带过去。
 *
 * 为什么不用 `?initialMessage=`、为什么要自己建对话，见
 * `hooks/usePluginInstallNotice.ts` 的 `handOffToAgent` 说明 —— 那是第一个用这条路的地方。
 *
 * 失败（建不了对话）直接抛，提示什么由调用方决定。
 */
import i18n from '@renderer/i18n'
import router from '@renderer/router'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { appExecuteAgent } from './appAgentRunner'
import { ensureSessionWithTitle } from './chatSendPrimitives'

export function startAgentChat(prompt: string, sidPrefix: string): void {
  const chatSid = `${sidPrefix}-${Date.now()}`
  ensureSessionWithTitle(chatSid, prompt, {
    chatStore: useChatSessionsStore(),
    tabsStore: useTabsStore(),
    route: router.currentRoute.value,
    unnamedTitle: i18n.global.t('assistant.chatFlow.unnamedChat')
  })
  void router.push({ path: '/dev-assistant', query: { sid: chatSid } })
  void appExecuteAgent(prompt, undefined, { chatSid })
}
