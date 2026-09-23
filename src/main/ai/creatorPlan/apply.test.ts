/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import type { CreatorPlanManifest } from '../../../shared/creatorPlan'
import { normalizeSettings } from '../store'
import type { AiProviderSettings, ProviderConfig } from '../types'
import {
  PLAN_KEY_ID,
  PLAN_PROVIDER_ID,
  PLAN_PROVIDER_IDS,
  applyPlan,
  managedRoles,
  planProviders,
  planRoleChanges,
  planSummary,
  recordOriginals,
  refreshPlanModels,
  removePlan
} from './apply'

const chatSpec = (model: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model,
  display_name: `Creator · ${model}`,
  context_window: 131072,
  max_output_tokens: 16384,
  supports_vision: false,
  supports_video: false,
  supports_tools: true,
  supports_reasoning: true,
  reasoning_efforts: ['none', 'low', 'medium', 'high'],
  structured_output: 'json-schema',
  ...extra
})

const manifest: CreatorPlanManifest = {
  schema: 1,
  etag: 'p-1',
  plan: {
    product: 'UEBox Creator Plan',
    tier: 'pro',
    tier_name: 'Pro',
    status: 'active',
    interval: 'month',
    current_period_end: '2026-10-01T00:00:00Z',
    cancel_at_period_end: false,
    quota_resets_at: '2026-10-01T00:00:00Z',
    manage_url: 'https://plan.example/account/billing'
  },
  quotas: { text_tokens: { limit: 1000, used: 10 } },
  api: { base_url: 'https://plan.example/v1' },
  roles: {
    chat: chatSpec('uebox-chat'),
    agent: chatSpec('uebox-agent', { supports_vision: true, context_window: 262144 }),
    vision: chatSpec('uebox-vision', { supports_vision: true, supports_reasoning: false }),
    summary: chatSpec('uebox-fast'),
    judge: null
  }
}

/** 清单里所有角色都有的那份（协议 01-plan 的示例） */
const fullManifest: CreatorPlanManifest = {
  ...manifest,
  roles: {
    ...manifest.roles,
    embedding: { model: 'uebox-embed-v1', dimensions: 1024, max_batch: 64, max_input_tokens: 8192 },
    image: { model: 'uebox-image', max_images: 4, sizes: ['1K', '2K'] },
    video: { model: 'uebox-video', duration: { min: 4, max: 10 } },
    model3d: { model: 'uebox-3d', options: ['negative_prompt'] },
    music: { model: 'uebox-music', seconds: { min: 10, max: 240 }, vocals: false },
    realtime: { model: 'uebox-realtime', voices: ['uebox-voice-f1', 'uebox-voice-m1'] },
    tts: {
      model: 'uebox-tts',
      voices: ['uebox-voice-f1', 'uebox-voice-f2'],
      default_voice: 'uebox-voice-f2',
      max_input_chars: 2000
    },
    stt: { model: 'uebox-stt', languages: ['zh', 'en'], streaming: true },
    search: { model: 'uebox-search', max_results: 10 },
    judge: { model: 'uebox-judge' }
  }
}

const keyRef = { kind: 'literal', id: PLAN_KEY_ID } as const

const mine = {
  id: 'my-gateway',
  displayName: 'My Gateway',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://gw.example/v1',
  apiKey: { kind: 'none' },
  models: [{ id: 'gpt-x' }]
} as AiProviderSettings['providers'][number]

const base: AiProviderSettings = {
  version: 3,
  providers: [mine],
  roles: { chat: { providerId: 'my-gateway', modelId: 'gpt-x' } }
}

describe('planProviders', () => {
  it('对话模型装进一个来源，能力按清单写，共用套餐的 Key', () => {
    const [provider, ...rest] = planProviders(manifest, keyRef)
    expect(rest).toEqual([])
    expect(provider).toMatchObject({
      id: PLAN_PROVIDER_ID,
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://plan.example/v1',
      apiKey: keyRef
    })
    expect(provider!.models.map((m) => m.id)).toEqual([
      'uebox-chat',
      'uebox-agent',
      'uebox-vision',
      'uebox-fast'
    ])
    const agent = provider!.models.find((m) => m.id === 'uebox-agent')!
    expect(agent).toMatchObject({
      supportsVision: true,
      contextWindow: 262144,
      maxOutputTokens: 16384,
      structuredOutputApi: 'json-schema'
    })
    expect(agent.thinkingLevelMap).toEqual({
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null
    })
    // 不支持推理的模型不给档位表
    expect(provider!.models.find((m) => m.id === 'uebox-vision')!.thinkingLevelMap).toBeUndefined()
  })

  it('落盘归一化后字段不丢', () => {
    const settings = normalizeSettings({
      ...base,
      providers: [...base.providers, ...planProviders(manifest, keyRef)]
    })
    const plan = settings.providers.find((p) => p.id === PLAN_PROVIDER_ID)!
    expect(plan.apiKey).toEqual(keyRef)
    expect(plan.models).toHaveLength(4)
  })
})

describe('planProviders 非对话角色', () => {
  it('一类一个来源，id 固定、共用一把 Key，各类的调用形状写在模型或来源上', () => {
    const providers = planProviders(fullManifest, keyRef)
    expect(providers.map((p) => [p.kind, p.id])).toEqual([
      ['chat', 'creator-plan'],
      ['embedding', 'creator-plan-embedding'],
      ['image', 'creator-plan-image'],
      ['video', 'creator-plan-video'],
      ['model3d', 'creator-plan-model3d'],
      ['realtime', 'creator-plan-realtime'],
      ['tts', 'creator-plan-tts'],
      ['stt', 'creator-plan-stt'],
      ['music', 'creator-plan-music'],
      ['search', 'creator-plan-search'],
      ['judge', 'creator-plan-judge']
    ])
    for (const provider of providers) {
      expect(provider.apiKey).toEqual(keyRef)
      expect(provider.baseUrl).toBe('https://plan.example/v1')
    }
    const byKind = Object.fromEntries(providers.map((p) => [p.kind, p]))
    expect(byKind.embedding.models).toEqual([
      {
        id: 'uebox-embed-v1',
        displayName: 'uebox-embed-v1',
        embeddingApi: 'jina-embeddings',
        embeddingDimensions: 1024
      }
    ])
    expect(byKind.image.models[0].imageApi).toBe('uebox-images')
    expect(byKind.video.videoApi).toBe('uebox-tasks')
    expect(byKind.model3d.model3dApi).toBe('uebox-tasks')
    expect(byKind.music.musicApi).toBe('uebox-tasks')
    expect(byKind.realtime.models[0].realtimeVoice).toBe('uebox-voice-f1')
    expect(byKind.tts.models[0].ttsVoice).toBe('uebox-voice-f2')
    expect(byKind.judge.models).toEqual([{ id: 'uebox-judge', displayName: 'uebox-judge' }])
  })

  it('来源 id 不许改：嵌入的向量标识和任务令牌都靠它', () => {
    expect(PLAN_PROVIDER_IDS.embedding).toBe('creator-plan-embedding')
    expect(PLAN_PROVIDER_IDS.video).toBe('creator-plan-video')
    expect(PLAN_PROVIDER_IDS.model3d).toBe('creator-plan-model3d')
  })

  it('落盘归一化后各类字段不丢，清单刷新不会误判成有变化', () => {
    const settings = normalizeSettings({
      ...base,
      providers: [...base.providers, ...planProviders(fullManifest, keyRef)]
    })
    const find = (id: string): ProviderConfig => settings.providers.find((p) => p.id === id)!
    expect(find('creator-plan-embedding').models[0]).toMatchObject({
      embeddingApi: 'jina-embeddings',
      embeddingDimensions: 1024
    })
    expect(find('creator-plan-image').models[0].imageApi).toBe('uebox-images')
    expect(find('creator-plan-video').videoApi).toBe('uebox-tasks')
    expect(find('creator-plan-model3d').model3dApi).toBe('uebox-tasks')
    expect(find('creator-plan-music').musicApi).toBe('uebox-tasks')
    expect(find('creator-plan-tts').models[0].ttsVoice).toBe('uebox-voice-f2')
    expect(find('creator-plan-realtime').models[0].realtimeVoice).toBe('uebox-voice-f1')
    // 同一份清单再刷新一次：什么都没变，原样返回（不白写盘）
    expect(refreshPlanModels(settings, fullManifest)).toBe(settings)
  })

  it('清单刷新只改能力：嵌入维度变了跟着改，不增删模型', () => {
    const settings = normalizeSettings({
      ...base,
      providers: [...base.providers, ...planProviders(fullManifest, keyRef)]
    })
    const next = refreshPlanModels(settings, {
      ...fullManifest,
      roles: {
        ...fullManifest.roles,
        embedding: { model: 'uebox-embed-v1', dimensions: 2048 },
        image: null
      }
    })
    const find = (id: string): ProviderConfig => next.providers.find((p) => p.id === id)!
    expect(find('creator-plan-embedding').models[0].embeddingDimensions).toBe(2048)
    // 清单里 image 为 null（订阅失效也是这样）：来源和模型都留着
    expect(find('creator-plan-image').models.map((m) => m.id)).toEqual(['uebox-image'])
  })
})

describe('applyPlan 非对话角色', () => {
  it('绑到各自类别的来源；断开时一起删掉、还原原绑定', () => {
    const settings: AiProviderSettings = {
      ...base,
      providers: [
        ...base.providers,
        {
          id: 'my-embed',
          displayName: 'My Embed',
          kind: 'embedding',
          protocol: 'openai-completions',
          baseUrl: 'https://embed.example/v1',
          apiKey: { kind: 'none' },
          models: [{ id: 'bge-m3' }]
        }
      ],
      roles: { ...base.roles, embedding: { providerId: 'my-embed', modelId: 'bge-m3' } }
    }
    const selected = ['embedding', 'image', 'video', 'tts', 'judge'] as const
    const originals = recordOriginals({}, settings, fullManifest, [...selected])
    expect(originals).toEqual({
      embedding: { providerId: 'my-embed', modelId: 'bge-m3' },
      image: null,
      video: null,
      tts: null,
      judge: null
    })
    const applied = applyPlan(settings, fullManifest, keyRef, [...selected])
    expect(applied.roles.embedding).toEqual({
      providerId: 'creator-plan-embedding',
      modelId: 'uebox-embed-v1',
      source: 'plan'
    })
    expect(applied.roles.video).toEqual({
      providerId: 'creator-plan-video',
      modelId: 'uebox-video',
      source: 'plan'
    })
    expect(applied.roles.judge?.providerId).toBe('creator-plan-judge')
    // 没勾的不动
    expect(applied.roles.search).toBeUndefined()
    // 落盘归一化后绑定都还在（来源的 kind 对得上）
    expect(normalizeSettings(applied).roles).toEqual(applied.roles)

    const removed = removePlan(applied, originals)
    expect(removed.providers.map((p) => p.id)).toEqual(['my-gateway', 'my-embed'])
    expect(removed.roles).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      embedding: { providerId: 'my-embed', modelId: 'bge-m3' }
    })
  })

  it('导入预览列出清单里有的全部角色，为 null 的不出现', () => {
    const changes = planRoleChanges(base, fullManifest)
    expect(changes.map((c) => c.role)).toEqual([
      'chat',
      'agent',
      'vision',
      'summary',
      'embedding',
      'image',
      'video',
      'model3d',
      'realtime',
      'tts',
      'stt',
      'music',
      'search',
      'judge'
    ])
    expect(planRoleChanges(base, manifest).map((c) => c.role)).not.toContain('judge')
  })
})

describe('planRoleChanges', () => {
  it('没绑的默认勾；用户自己配的默认不勾，并写明现在是什么', () => {
    const changes = planRoleChanges(base, manifest)
    expect(changes.map((c) => c.role)).toEqual(['chat', 'agent', 'vision', 'summary'])
    const chat = changes.find((c) => c.role === 'chat')!
    expect(chat).toMatchObject({
      defaultSelected: false,
      managed: false,
      current: { providerId: 'my-gateway', modelId: 'gpt-x', providerName: 'My Gateway' }
    })
    expect(changes.find((c) => c.role === 'agent')).toMatchObject({
      defaultSelected: true,
      current: null
    })
  })

  it('套餐管着的角色默认勾，标成「套餐管理中」', () => {
    const applied = applyPlan(base, manifest, keyRef, ['agent'])
    const agent = planRoleChanges(applied, manifest).find((c) => c.role === 'agent')!
    expect(agent).toMatchObject({ managed: true, defaultSelected: true })
  })
})

describe('applyPlan', () => {
  it('只换选中的角色，带上 source；用户自己的来源和绑定不动', () => {
    const next = applyPlan(base, manifest, keyRef, ['agent', 'summary'])
    expect(next.roles).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      agent: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-agent', source: 'plan' },
      summary: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-fast', source: 'plan' }
    })
    expect(next.providers.map((p) => p.id)).toEqual(['my-gateway', PLAN_PROVIDER_ID])
    expect(managedRoles(next)).toEqual(['agent', 'summary'])
  })

  it('勾选了用户配过的角色：换成套餐', () => {
    const next = applyPlan(base, manifest, keyRef, ['chat'])
    expect(next.roles.chat).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: 'uebox-chat',
      source: 'plan'
    })
  })

  it('重新导入时取消勾选：套餐不再管它，解绑', () => {
    const first = applyPlan(base, manifest, keyRef, ['agent', 'summary'])
    const second = applyPlan(first, manifest, keyRef, ['agent'])
    expect(second.roles.summary).toBeUndefined()
    expect(second.roles.agent?.source).toBe('plan')
  })

  it('清单里某个角色没了：套餐管着的那条解绑，用户手动改过的不动', () => {
    const first = applyPlan(base, manifest, keyRef, ['agent', 'vision'])
    // 用户后来手动把 vision 改到自己的来源（渲染层改绑定不带 source）
    first.roles.vision = { providerId: 'my-gateway', modelId: 'gpt-x' }
    const shrunk = { ...manifest, roles: { ...manifest.roles, agent: null, vision: null } }
    const second = applyPlan(first, shrunk, keyRef, ['agent', 'vision'])
    expect(second.roles.agent).toBeUndefined()
    expect(second.roles.vision).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
  })

  it('重复导入不会叠出两个套餐来源', () => {
    const twice = applyPlan(applyPlan(base, manifest, keyRef, ['agent']), manifest, keyRef, [
      'agent'
    ])
    expect(twice.providers.filter((p) => p.id === PLAN_PROVIDER_ID)).toHaveLength(1)
  })
})

describe('removePlan', () => {
  it('删掉套餐来源和它管着的角色，用户自己的留着', () => {
    const applied = applyPlan(base, manifest, keyRef, ['agent', 'vision'])
    const removed = removePlan(applied)
    expect(removed.providers.map((p) => p.id)).toEqual(['my-gateway'])
    expect(removed.roles).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
  })
})

describe('recordOriginals', () => {
  it('只记这次勾上、清单里有的角色；已经记过的不覆盖', () => {
    // 清单里没有 image（这份 manifest 只有对话四个）：不记
    const first = recordOriginals({}, base, manifest, ['chat', 'image'])
    expect(first).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
    const applied = applyPlan(base, manifest, keyRef, ['chat'])
    // 重新导入时 chat 的「现在」已经是套餐，最初那条才是用户自己的
    expect(recordOriginals(first, applied, manifest, ['chat', 'agent'])).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      agent: null
    })
  })

  it('原来就由套餐管着、又没有记录的：按「原来没设置」记', () => {
    const managed = applyPlan(base, manifest, keyRef, ['agent'])
    expect(recordOriginals({}, managed, manifest, ['agent'])).toEqual({ agent: null })
  })
})

describe('removePlan 还原', () => {
  it('还原成原绑定；原绑定的模型已经不在了 → 未设置', () => {
    const applied = applyPlan(base, manifest, keyRef, ['chat', 'agent'])
    const removed = removePlan(applied, {
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      agent: { providerId: 'my-gateway', modelId: 'gone' }
    })
    expect(removed.roles).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
  })
})

describe('planSummary 额度', () => {
  it('逐项列出，按额度表排序，不认识的键排后面；形状不对的丢掉', () => {
    const summary = planSummary({
      ...manifest,
      quotas: {
        future_units: { limit: 5, used: 1 },
        images: { limit: 100, used: 3 },
        text_tokens: { limit: 1000, used: 10 },
        broken: { limit: 'x' } as unknown as { limit: number; used: number }
      }
    })
    expect(summary.quotas.map((q) => q.key)).toEqual(['text_tokens', 'images', 'future_units'])
    expect(summary.quotas[1]).toEqual({ key: 'images', limit: 100, used: 3 })
  })
})

describe('source 字段落盘', () => {
  it('归一化保留 source: plan，丢弃别的值', () => {
    const settings = normalizeSettings({
      version: 3,
      providers: [mine],
      roles: {
        chat: { providerId: 'my-gateway', modelId: 'gpt-x', source: 'plan' },
        agent: { providerId: 'my-gateway', modelId: 'gpt-x', source: 'whatever' }
      }
    })
    expect(settings.roles.chat).toEqual({
      providerId: 'my-gateway',
      modelId: 'gpt-x',
      source: 'plan'
    })
    expect(settings.roles.agent).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
  })
})
