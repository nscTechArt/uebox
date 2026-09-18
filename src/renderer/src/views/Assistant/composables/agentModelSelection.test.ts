import { describe, expect, it } from 'vitest'
import type { ProviderView, SettingsView } from '@core/shared/aiProvider'
import { agentModelOptionKey, buildAgentModelCatalog } from './agentModelSelection'

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    kind: 'chat',
    protocol: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    models: [{ id: 'gpt-5.4', displayName: 'GPT 5.4' }],
    apiKey: { kind: 'none' },
    ...overrides
  }
}

function settings(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    providers: [provider()],
    roles: { agent: { providerId: 'openai', modelId: 'gpt-5.4' } },
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: true,
    ...overrides
  }
}

describe('buildAgentModelCatalog', () => {
  it('只列对话 Provider，并按 Provider 分组保留模型身份', () => {
    const value = settings({
      providers: [
        provider({
          models: [{ id: 'gpt-5.4', displayName: 'GPT 5.4' }, { id: 'openai::gpt-next' }]
        }),
        provider({
          id: 'image',
          displayName: 'Image Provider',
          kind: 'image',
          models: [{ id: 'gpt-image-1' }]
        })
      ]
    })

    const catalog = buildAgentModelCatalog(value)

    expect(catalog.groups).toHaveLength(1)
    expect(catalog.options.map((option) => option.modelId)).toEqual(['gpt-5.4', 'openai::gpt-next'])
    expect(catalog.options[0]).toMatchObject({
      modelName: 'GPT 5.4',
      fullLabel: 'GPT 5.4 · OpenAI'
    })
  })

  it('Agent 未单独绑定时显示内核实际回落使用的 chat 模型', () => {
    const value = settings({
      roles: { chat: { providerId: 'openai', modelId: 'gpt-5.4' } }
    })

    const catalog = buildAgentModelCatalog(value)

    expect(catalog.binding).toEqual({ providerId: 'openai', modelId: 'gpt-5.4' })
    expect(catalog.selected?.modelName).toBe('GPT 5.4')
  })

  it('Agent 专用绑定优先于 chat 回落', () => {
    const value = settings({
      providers: [
        provider({
          models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }]
        })
      ],
      roles: {
        chat: { providerId: 'openai', modelId: 'gpt-5.4-mini' },
        agent: { providerId: 'openai', modelId: 'gpt-5.4' }
      }
    })

    expect(buildAgentModelCatalog(value).selected?.modelId).toBe('gpt-5.4')
  })

  it('选项键不会被 Provider 或模型 id 自带的分隔符碰撞', () => {
    expect(agentModelOptionKey('gateway::one', 'vendor::model')).toBe(
      '["gateway::one","vendor::model"]'
    )
  })
})
