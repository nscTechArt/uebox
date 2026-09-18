/**
 * 应用级的 agent 运行器 —— 「谁来跑一轮」这件事不归任何页面。
 *
 * ## 为什么要有
 *
 * `useAgentMode.executeAgent` 是组件级的 composable，于是每一处「后台要发起一轮」
 * 都得去借一个挂着的页面。而助手路由没开 `meta.keepAlive`：用户切去看素材库那一刻
 * 整棵组件树就卸载了，借不到人。这个坑仓库里已经踩出两处：
 *
 *   - 排着的跟进消息（`followUpDelivery`）：跑完没人接，用户排的话一直挂着；
 *   - 实时语音派活（`voiceAssistant`）：报一句「助手页面都关了，请让用户先打开一个
 *     助手页面再派活」—— 而用户什么也没关，他只是切了个页面去看别的。
 *
 * 所以在常驻布局里建**一个**实例，谁要跑一轮就用它。页面回到它该在的位置：
 * 显示 store 里的东西，在不在都不影响后台把活干完。
 *
 * ## 为什么 sid 是空串
 *
 * `executeAgent` 里用 `chatSid === sid.value` 判「是不是用户正对着的这条」。空串
 * 对不上任何一条真实对话，于是这个实例对每条对话都是「不是当前对话」，一律走
 * `executeAgent(..., { chatSid })` 那条路：气泡、流式状态、过程时间线全部建在
 * **目标对话**的 store 上。这条路实时语音派活一直在走，不是新开的。
 *
 * 代价是页面本地那两个镜像（`currentAgentProcess`、`fullConversationHistory`）不再
 * 由这条路填。界面读的是 store（`resolveProcessItems` 优先取 store 那份），所以
 * 过程日志照常显示；`fullConversationHistory` 是 V2 遗留，只影响 `setAgentHistory`。
 */

import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'

import { useAgentMode } from './useAgentMode'

type ExecuteAgent = ReturnType<typeof useAgentMode>['executeAgent']

/**
 * 模块级，整个渲染进程一份。
 *
 * 由常驻布局在 setup 里装上 —— `useAgentMode` 内部要 `useI18n()` 和生命周期钩子，
 * 那些只有在组件上下文里才立得住，而常驻布局的寿命就是应用的寿命。
 */
let runner: ExecuteAgent | null = null

/**
 * 只给测试用：直接塞一个运行器（或传 null 清掉）。
 *
 * 用例里没有真的常驻布局可挂，而「派活会不会去借页面」恰恰是这一层要守的东西。
 */
export function __setAppAgentRunnerForTest(fn: ExecuteAgent | null): void {
  runner = fn
}

/** 在常驻布局的 setup 里调一次。重复调用只会换成新的那个实例 */
export function useAppAgentRunner(): void {
  const route = useRoute()

  const { executeAgent } = useAgentMode({
    // 见文件头：空串 = 「没有当前对话」，一切都落在 { chatSid } 指定的那条上
    sid: ref(''),
    messages: computed(() => []),
    chatStore: useChatSessionsStore(),
    chatMsgStore: useChatMessagesStore(),
    tabsStore: useTabsStore(),
    route,
    // 后台跑的这一轮没有可滚的界面；用户正看着的那条由页面自己滚
    scrollToBottomIfNeeded: () => {},
    // 这两个是「当前对话」专用入口，`isCurrent` 恒假时走不到
    pushUser: () => {},
    pushAssistantTyping: () => '',
    currentAgentProcess: ref([])
  })

  runner = executeAgent
}

/**
 * 发起一轮，目标对话由 `options.chatSid` 指定。
 *
 * 运行器还没装上时**抛出**而不是静默返回：这只可能发生在常驻布局挂载之前，属于
 * 接线错误。悄悄咽下去的话，用户看到的是"派了活但什么都没发生"，而那正是这次
 * 要消灭的那类症状。
 */
export const appExecuteAgent: ExecuteAgent = (message, excelContext, options) => {
  if (!runner) {
    return Promise.reject(new Error('agent 运行器还没装上（常驻布局尚未挂载）'))
  }
  return runner(message, excelContext, options)
}
