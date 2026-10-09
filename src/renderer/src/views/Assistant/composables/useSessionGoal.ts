/**
 * 目标模式（`/goal`）输入框上方那一行「当前目标」。目标跨轮，用户点掉才没。
 *
 * 真相源是主进程落盘的执行配置（`sessionExecutionOptions` 的 `goal`），这里只读。
 * 重读时机同 `useTeamBoard`：换对话、主进程推 `agent-v3:goal-state`、一轮跑完兜底。
 */

import { computed, onUnmounted, ref, watch, type Ref } from 'vue'

import { useI18n } from 'vue-i18n'

import { agentV3API } from '@renderer/api/agentV3'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { message } from '@renderer/utils/messageManager'

export interface UseSessionGoal {
  objective: Ref<string | null>
  /** 取消这条对话的目标。成功不用提示：主进程推一下，那一行自己就没了 */
  cancel: () => Promise<void>
}

export function useSessionGoal(chatSid: Ref<string>): UseSessionGoal {
  const chatStore = useChatSessionsStore()
  const { t } = useI18n()
  const objective = ref<string | null>(null)
  const agentSessionId = computed(() =>
    chatSid.value ? chatStore.getAgentSessionId(chatSid.value) : ''
  )

  let generation = 0
  const refresh = async (): Promise<void> => {
    const sessionId = agentSessionId.value
    const mine = ++generation
    if (!sessionId) {
      objective.value = null
      return
    }
    try {
      const goal = await agentV3API.goalState(sessionId)
      if (mine === generation) objective.value = goal?.objective ?? null
    } catch {
      // 读不到就保留上一次的，别让那一行闪
    }
  }

  const onChange = (...args: unknown[]): void => {
    const payload = args[0] as { sessionId?: string } | undefined
    if (payload?.sessionId && payload.sessionId === agentSessionId.value) void refresh()
  }

  const goalHandler = window.api.on('agent-v3:goal-state', onChange)
  const releasedHandler = window.api.on('agent-v3:released', onChange)
  watch(agentSessionId, () => void refresh(), { immediate: true })

  onUnmounted(() => {
    window.api.off('agent-v3:goal-state', goalHandler)
    window.api.off('agent-v3:released', releasedHandler)
  })

  const cancel = async (): Promise<void> => {
    const sessionId = agentSessionId.value
    if (!sessionId) return
    const result = await agentV3API.goalEnd(sessionId).catch(() => null)
    if (result?.success) return
    message.error(
      t(
        result?.errorKey === 'running'
          ? 'assistant.composer.cancelGoalWhileRunning'
          : 'assistant.composer.cancelGoalFailed'
      )
    )
  }

  return { objective, cancel }
}
