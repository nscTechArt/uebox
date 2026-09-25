/**
 * 工作室模式（`/team`）的任务板面板数据。
 *
 * 主进程那份账（名册、任务板、留言，见 `main/agent-v3/core/team/teamStore.ts`）是真相源，
 * 这里只负责读出来、在它变的时候重读。
 *
 * ## 什么时候重读
 *
 * - 换了会话（chatSid 变了，或者这条会话第一次拿到 agent sessionId）
 * - 主进程推 `agent-v3:team-board`：名册、任务板、留言、验收结论任何一样变了
 * - 这条会话的一轮跑完（`agent-v3:released`）：兜底，万一哪次推送没接上
 *
 * 不轮询：不是工作室的会话一次查询都不该多花。
 */

import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'

import type { TeamStateView } from '@core/shared/agentTeam'
import { agentV3API } from '@renderer/api/agentV3'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

export interface UseTeamBoard {
  team: Ref<TeamStateView | null>
  /** 这条会话是不是工作室 */
  active: ComputedRef<boolean>
  refresh: () => Promise<void>
}

export function useTeamBoard(chatSid: Ref<string>): UseTeamBoard {
  const chatStore = useChatSessionsStore()
  const team = ref<TeamStateView | null>(null)
  const agentSessionId = computed(() =>
    chatSid.value ? chatStore.getAgentSessionId(chatSid.value) : ''
  )

  // 两次重读撞在一起时，只认最后发出去的那一次，免得旧结果盖掉新结果
  let generation = 0
  const refresh = async (): Promise<void> => {
    const sessionId = agentSessionId.value
    const mine = ++generation
    if (!sessionId) {
      team.value = null
      return
    }
    try {
      const next = await agentV3API.teamState(sessionId)
      if (mine === generation) team.value = next
    } catch {
      // 读不到不是错，只是这一次没读到。保留上一次的值，别让面板闪
    }
  }

  const onChange = (...args: unknown[]): void => {
    const payload = args[0] as { sessionId?: string } | undefined
    if (payload?.sessionId && payload.sessionId === agentSessionId.value) void refresh()
  }

  window.api.on('agent-v3:team-board', onChange)
  window.api.on('agent-v3:released', onChange)
  watch(agentSessionId, () => void refresh(), { immediate: true })

  onUnmounted(() => {
    window.api.off('agent-v3:team-board', onChange)
    window.api.off('agent-v3:released', onChange)
  })

  return { team, active: computed(() => team.value !== null), refresh }
}
