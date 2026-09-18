import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { normalizeAIConfig, useAIConfigStore, type AIConfigState } from './aiConfig'

describe('normalizeAIConfig', () => {
  // 早期版本存进 localStorage 的那份就是没有这两个字段
  it('给缺失的两个提供商补上默认值', () => {
    const config: Partial<AIConfigState> = {}

    expect(normalizeAIConfig(config)).toBe(true)
    expect(config.normalProvider).toBe('gemini')
    expect(config.agentProvider).toBe('openai')
  })

  // 已经填好的不该被改写 —— 每次改写都会触发一次多余的持久化
  it('已有配置原样保留并报告没改动', () => {
    const config: AIConfigState = { normalProvider: 'claude', agentProvider: 'xai' }

    expect(normalizeAIConfig(config)).toBe(false)
    expect(config.normalProvider).toBe('claude')
    expect(config.agentProvider).toBe('xai')
  })
})

/**
 * 这里存的**不是**「全局权限档位」——真正生效的那一份在会话上
 * （chatSessions.permissionModeById）。这个值只回答一个问题：
 * 下次新开一条对话，权限从哪一档起步。
 */
describe('agentPermissionMode', () => {
  function store(): ReturnType<typeof useAIConfigStore> {
    setActivePinia(createPinia())
    return useAIConfigStore()
  }

  it('新用户默认只问不可逆', () => {
    expect(store().agentPermissionMode).toBe('auto-edit')
  })

  // 用户上次调成哪一档，下次新会话就从哪一档起步 —— 包括只读那一档
  it.each(['read-only', 'ask', 'auto-edit', 'yolo'] as const)('选了 %s 就记住 %s', (mode) => {
    const s = store()
    s.setAgentPermissionMode(mode)
    expect(s.agentPermissionMode).toBe(mode)
  })
})

describe('followUpSuggestionsEnabled', () => {
  function store(): ReturnType<typeof useAIConfigStore> {
    setActivePinia(createPinia())
    return useAIConfigStore()
  }

  it('新用户默认开启智能追加提问', () => {
    expect(store().followUpSuggestionsEnabled).toBe(true)
  })

  it('用户明确关闭后保持关闭', () => {
    const s = store()
    s.setFollowUpSuggestionsEnabled(false)
    expect(s.followUpSuggestionsEnabled).toBe(false)
  })

  it('重置配置后恢复默认开启', () => {
    const s = store()
    s.setFollowUpSuggestionsEnabled(false)
    s.resetConfig()
    expect(s.followUpSuggestionsEnabled).toBe(true)
  })
})
