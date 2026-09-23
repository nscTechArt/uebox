import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import enUS from '@renderer/i18n/locales/en-US'
import zhCN from '@renderer/i18n/locales/zh-CN'

vi.mock('@renderer/utils/messageManager', () => ({
  message: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() }
}))
vi.mock('./agentEventDispatcher', () => ({
  unregisterAgentHandler: vi.fn(),
  isCurrentRun: vi.fn(() => true)
}))

import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { createAgentControlHandlers } from './agentControlHandlers'
import { AGENT_RESUME_ACTION } from './agentHandlerShared'
import {
  CREATOR_PLAN_MANAGE_ACTION,
  CREATOR_PLAN_RECONNECT_ACTION,
  creatorPlanErrorInfo,
  creatorPlanErrorText,
  dailyResetText,
  runCreatorPlanAction
} from './creatorPlanChatError'

/**
 * 对话里的套餐错误提示：402 / 403 挂「管理订阅」，401 挂「去重新连接」，都不挂「接着跑」。
 * 只有主进程判定是套餐来源（带了 planError）才走这条；别的来源同样的 402 还是通用文案。
 */

/** 用真语言包：文案是拼出来的 key，`usedKeyCoverage` 扫不到，漏配得在这里抓 */
function translator(pack: unknown): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pack)
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (whole, name: string) =>
      params && name in params ? String(params[name]) : whole
    )
  }
}

const CODES = [
  'subscription_inactive',
  'quota_exhausted',
  'daily_limit_reached',
  'role_not_in_plan',
  'unauthorized'
] as const

describe('creatorPlanErrorInfo', () => {
  it.each([
    ['zh-CN', zhCN],
    ['en-US', enUS]
  ])('%s：每种错误都有标题、说明和按钮文案，占位符都填上了', (_name, pack) => {
    const t = translator(pack)
    for (const code of CODES) {
      const info = creatorPlanErrorInfo(code, t)
      expect(info.display).not.toContain('aiProvider.')
      expect(info.display).not.toMatch(/\{\w+\}/)
      expect(info.actionButtons[0]!.label).not.toContain('aiProvider.')
      expect(info.fatal).toBe(true)
    }
  })

  it('402 / 403 → 管理订阅；401 → 去重新连接', () => {
    const t = translator(zhCN)
    for (const code of [
      'subscription_inactive',
      'quota_exhausted',
      'daily_limit_reached',
      'role_not_in_plan'
    ] as const) {
      expect(creatorPlanErrorInfo(code, t).actionButtons).toEqual([
        { label: '管理订阅', action: CREATOR_PLAN_MANAGE_ACTION }
      ])
    }
    expect(creatorPlanErrorInfo('unauthorized', t).actionButtons).toEqual([
      { label: '去重新连接', action: CREATOR_PLAN_RECONNECT_ACTION }
    ])
  })
})

describe('每日上限 daily_limit_reached', () => {
  it('说今天的额度用完了、本机时间几点恢复（下一个 00:00 UTC）', () => {
    const now = Date.UTC(2026, 8, 23, 15, 30)
    const reset = new Date(Date.UTC(2026, 8, 24))
    const clock = `${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`
    const sameLocalDay = new Date(now).toDateString() === reset.toDateString()

    const zh = creatorPlanErrorInfo('daily_limit_reached', translator(zhCN), now)
    expect(zh.display).toContain('今天的额度用完了')
    expect(zh.display).toContain(`${sameLocalDay ? '今天' : '明天'} ${clock} 恢复`)
    expect(zh.fatal).toBe(true)
    expect(dailyResetText(translator(enUS), now)).toBe(
      `${sameLocalDay ? 'today' : 'tomorrow'} at ${clock}`
    )
  })

  it('朗读的 toast 用一句话版：标题：说明', () => {
    const text = creatorPlanErrorText('daily_limit_reached', translator(zhCN))
    expect(text).toMatch(/^今天的额度用完了：.+ 恢复。/)
  })
})

describe('runCreatorPlanAction', () => {
  it('管理订阅走主进程打开 manage_url；去重新连接跳设置 → 模型；别的动作不管', async () => {
    const openManage = vi.fn(async () => {})
    window.api = { creatorPlan: { openManage } } as unknown as typeof window.api
    const openSettings = vi.fn()

    expect(await runCreatorPlanAction(CREATOR_PLAN_MANAGE_ACTION, openSettings)).toBe(true)
    expect(openManage).toHaveBeenCalledTimes(1)
    expect(await runCreatorPlanAction(CREATOR_PLAN_RECONNECT_ACTION, openSettings)).toBe(true)
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(await runCreatorPlanAction(AGENT_RESUME_ACTION, openSettings)).toBe(false)
  })
})

describe('handleAgentError 遇到套餐错误', () => {
  const SESSION = 'session-1'
  const CHAT = 'chat-1'

  function setup(): {
    handlers: ReturnType<typeof createAgentControlHandlers>
    lastAssistant: () => ReturnType<ReturnType<typeof useChatMessagesStore>['getMessages']>[number]
  } {
    setActivePinia(createPinia())
    const chatMsgStore = useChatMessagesStore()
    const agentStreamStore = useAgentStreamStore()
    chatMsgStore.pushUser(CHAT, '做个材质')
    const typingId = chatMsgStore.pushAssistantTyping(CHAT)
    agentStreamStore.initStream(CHAT, SESSION, typingId)
    const deps = {
      sid: ref(CHAT),
      chatMsgStore,
      agentStreamStore,
      currentAgentProcess: ref([]),
      currentSessionId: ref(SESSION),
      currentAgentController: ref(null),
      currentText: computed(() => ''),
      t: translator(zhCN),
      clearWikiRagState: vi.fn()
    }
    const handlers = createAgentControlHandlers(deps as never)
    const lastAssistant = (): ReturnType<typeof chatMsgStore.getMessages>[number] => {
      const messages = chatMsgStore.getMessages(CHAT)
      return messages[messages.length - 1]!
    }
    return { handlers, lastAssistant }
  }

  it('额度用完：显示套餐提示，挂「管理订阅」，不挂「接着跑」', async () => {
    const { handlers, lastAssistant } = setup()
    await handlers.handleAgentError(null, {
      sessionId: SESSION,
      message: '402 {"error":{"code":"quota_exhausted"}}',
      statusCode: 402,
      code: 'quota_exhausted',
      planError: 'quota_exhausted'
    })
    const bubble = lastAssistant()
    expect(String(bubble.content)).toContain('这项额度本周期用完了')
    expect(bubble.actionButtons).toEqual([
      { label: '管理订阅', action: CREATOR_PLAN_MANAGE_ACTION }
    ])
  })

  it('Key 失效：挂「去重新连接」', async () => {
    const { handlers, lastAssistant } = setup()
    await handlers.handleAgentError(null, {
      sessionId: SESSION,
      message: '401 {"error":{"code":"unauthorized"}}',
      statusCode: 401,
      planError: 'unauthorized'
    })
    expect(String(lastAssistant().content)).toContain('授权失效')
    expect(lastAssistant().actionButtons).toEqual([
      { label: '去重新连接', action: CREATOR_PLAN_RECONNECT_ACTION }
    ])
  })

  it('今天的额度用完（429）：套餐提示挂「管理订阅」，不按限流给「接着跑」', async () => {
    const { handlers, lastAssistant } = setup()
    await handlers.handleAgentError(null, {
      sessionId: SESSION,
      message: '429 {"error":{"code":"daily_limit_reached"}}',
      statusCode: 429,
      code: 'daily_limit_reached',
      planError: 'daily_limit_reached'
    })
    expect(String(lastAssistant().content)).toContain('今天的额度用完了')
    expect(String(lastAssistant().content)).toMatch(/\d{2}:\d{2} 恢复/)
    expect(lastAssistant().actionButtons).toEqual([
      { label: '管理订阅', action: CREATOR_PLAN_MANAGE_ACTION }
    ])
  })

  it('别的来源回同样的 402（没有 planError）：还是原来的「服务商余额不足」', async () => {
    const { handlers, lastAssistant } = setup()
    await handlers.handleAgentError(null, {
      sessionId: SESSION,
      message: '402 {"error":{"code":"quota_exhausted"}}',
      statusCode: 402,
      code: 'quota_exhausted'
    })
    expect(String(lastAssistant().content)).not.toContain('额度本周期用完')
    expect(lastAssistant().actionButtons).toBeUndefined()
  })
})
