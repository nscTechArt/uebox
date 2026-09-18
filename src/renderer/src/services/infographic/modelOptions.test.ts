import { describe, expect, it } from 'vitest'
import type { ProviderView, SettingsView } from '@core/shared/aiProvider'
import { buildInfographicModelOptions, resolveInfographicModelSelection } from './modelOptions'
import { DEFAULT_INFOGRAPHIC_CONFIG } from './types'

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'local-images',
    displayName: 'Local Images',
    kind: 'image',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: { kind: 'none' },
    models: [],
    ...overrides
  }
}

function settings(
  providers: ProviderView[],
  imageRole?: SettingsView['roles']['image']
): SettingsView {
  return {
    providers,
    roles: imageRole ? { image: imageRole } : {},
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: providers.length > 0
  }
}

describe('buildInfographicModelOptions', () => {
  it('只列生图用途、且凭据可用的 Provider 下的模型', () => {
    const result = buildInfographicModelOptions(
      settings([
        provider({ models: [{ id: 'flux-dev', displayName: 'FLUX Dev' }] }),
        // 对话用途的整条都不该出现 —— 以前靠模型上的能力位筛，现在靠 Provider 用途
        provider({
          id: 'chat-provider',
          displayName: 'Chat Provider',
          kind: 'chat',
          models: [{ id: 'chat-only', displayName: 'Chat Only' }]
        }),
        provider({
          id: 'missing-key',
          displayName: 'Missing Key',
          apiKey: { kind: 'literal', hasKey: false },
          models: [{ id: 'hidden-image' }]
        }),
        provider({
          id: 'cloud-images',
          displayName: 'Cloud Images',
          apiKey: { kind: 'literal', hasKey: true },
          models: [{ id: 'gpt-image-2' }]
        })
      ])
    )

    expect(result.map((option) => [option.providerId, option.modelId])).toEqual([
      ['local-images', 'flux-dev'],
      ['cloud-images', 'gpt-image-2']
    ])
    expect(result[0].modelName).toBe('FLUX Dev')
    expect(result[1]).toMatchObject({ imageSize: 'auto', aspectRatio: '1:1' })
  })

  it('一个生图用途的 Provider 都没有时返回空列表，交给界面跳转配置', () => {
    expect(
      buildInfographicModelOptions(
        settings([provider({ kind: 'chat', models: [{ id: 'chat-only' }] })])
      )
    ).toEqual([])
  })

  it('模型很多时不截断列表', () => {
    const models = Array.from({ length: 30 }, (_, index) => ({
      id: `image-${index}`
    }))

    expect(buildInfographicModelOptions(settings([provider({ models })]))).toHaveLength(30)
  })
})

describe('resolveInfographicModelSelection', () => {
  const source = settings(
    [
      provider({
        models: [{ id: 'image-a' }, { id: 'image-b' }]
      })
    ],
    { providerId: 'local-images', modelId: 'image-b' }
  )
  const options = buildInfographicModelOptions(source)

  it('优先恢复信息图自己的有效选择', () => {
    expect(
      resolveInfographicModelSelection(
        options,
        { ...DEFAULT_INFOGRAPHIC_CONFIG, providerId: 'local-images', modelId: 'image-a' },
        source
      )
    ).toBe(options[0].id)
  })

  it('保存项失效时回到全局生图绑定', () => {
    expect(
      resolveInfographicModelSelection(
        options,
        { ...DEFAULT_INFOGRAPHIC_CONFIG, providerId: 'gone', modelId: 'gone' },
        source
      )
    ).toBe(options[1].id)
  })
})
