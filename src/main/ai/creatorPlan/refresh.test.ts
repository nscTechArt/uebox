/** @vitest-environment node */
/**
 * 清单自动刷新：
 * - 没连接时一个请求都不发（启动那一轮、每 6 小时那一轮都是）
 * - 200 更新套餐来源里各模型的能力、缓存清单和 ETag；304 什么都不写
 * - 401 记成授权失效
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatorPlanManifest } from '../../../shared/creatorPlan'
import type { AiProviderSettings } from '../types'
import type { PlanState } from './planState'

let settings: AiProviderSettings
let planState: PlanState
let writes = 0

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

vi.mock('../store', () => ({
  readSettings: async () => settings,
  writeSettings: async (next: AiProviderSettings) => {
    writes += 1
    settings = next
    return next
  }
}))

vi.mock('../credentials', () => ({
  resolveApiKey: async () => 'ubx-sk-local'
}))

vi.mock('./planState', () => ({
  readPlanState: async () => planState,
  updatePlanState: async (patch: Partial<PlanState>) => {
    planState = { ...planState, ...patch }
    return planState
  }
}))

const { refreshPlan, startCreatorPlanRefresh, stopCreatorPlanRefresh, REFRESH_INTERVAL_MS } =
  await import('./refresh')
const { PLAN_KEY_ID, PLAN_PROVIDER_ID } = await import('./apply')

const spec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'uebox-agent',
  context_window: 131072,
  max_output_tokens: 16384,
  supports_vision: false,
  supports_video: false,
  supports_tools: true,
  supports_reasoning: false,
  structured_output: 'json-schema',
  ...extra
})

const manifest = (agent: Record<string, unknown> | null): CreatorPlanManifest => ({
  schema: 1,
  etag: 'p-2',
  plan: {
    product: 'UEBox Creator Plan',
    tier: 'pro',
    tier_name: 'Pro',
    status: 'active',
    interval: 'month',
    current_period_end: null,
    cancel_at_period_end: false,
    quota_resets_at: null,
    manage_url: 'https://plan.example/account/billing'
  },
  quotas: {},
  api: { base_url: 'https://plan.example/v1' },
  roles: { agent }
})

const mine = {
  id: 'my-gateway',
  displayName: 'My Gateway',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://gw.example/v1',
  apiKey: { kind: 'none' },
  models: [{ id: 'gpt-x', contextWindow: 8000 }]
} as AiProviderSettings['providers'][number]

const connected = (): AiProviderSettings => ({
  version: 3,
  providers: [
    mine,
    {
      id: PLAN_PROVIDER_ID,
      displayName: 'Creator Plan',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://plan.example/v1',
      apiKey: { kind: 'literal', id: PLAN_KEY_ID },
      models: [
        {
          id: 'uebox-agent',
          displayName: 'uebox-agent',
          supportsVision: false,
          supportsVideo: false,
          supportsTools: true,
          supportsReasoning: false,
          contextWindow: 131072,
          maxOutputTokens: 16384,
          structuredOutputApi: 'json-schema'
        }
      ]
    }
  ],
  roles: { agent: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-agent', source: 'plan' } }
})

function stubFetch(respond: () => Response): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn(async () => respond())
  vi.stubGlobal('fetch', fetchImpl)
  return fetchImpl
}

beforeEach(() => {
  writes = 0
  planState = { originals: {}, etag: null, manifest: null, unauthorized: false }
  settings = connected()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  stopCreatorPlanRefresh()
})

describe('refreshPlan', () => {
  it('没连接：回 null，不发请求', async () => {
    settings = { version: 3, providers: [mine], roles: {} }
    const fetchImpl = stubFetch(() => new Response('{}'))
    expect(await refreshPlan()).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('200：更新模型能力（上下文、看图），缓存清单和 ETag；别的来源不动', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify(manifest(spec({ context_window: 262144, supports_vision: true }))),
          { headers: { etag: '"p-2"' } }
        )
    )
    const outcome = await refreshPlan()
    expect(outcome).toMatchObject({ error: null, manifest: { etag: 'p-2' } })
    const model = settings.providers.find((p) => p.id === PLAN_PROVIDER_ID)!.models[0]!
    expect(model).toMatchObject({ contextWindow: 262144, supportsVision: true })
    expect(settings.providers[0]).toBe(mine)
    expect(settings.roles.agent).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: 'uebox-agent',
      source: 'plan'
    })
    expect(planState).toMatchObject({ etag: '"p-2"', manifest: { etag: 'p-2' } })
  })

  it('能力没变：不写配置', async () => {
    stubFetch(() => new Response(JSON.stringify(manifest(spec()))))
    await refreshPlan()
    expect(writes).toBe(0)
  })

  it('订阅失效（roles 全是 null）：不删模型，来源还在，连接不丢', async () => {
    stubFetch(() => new Response(JSON.stringify(manifest(null))))
    await refreshPlan()
    expect(settings.providers.find((p) => p.id === PLAN_PROVIDER_ID)!.models).toHaveLength(1)
  })

  it('有缓存时带 If-None-Match；304 用缓存，什么都不写', async () => {
    const cached = manifest(spec())
    planState = { ...planState, etag: '"p-1"', manifest: cached }
    const fetchImpl = stubFetch(() => new Response(null, { status: 304 }))
    expect(await refreshPlan()).toEqual({ manifest: cached, error: null })
    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['if-none-match']).toBe('"p-1"')
    expect(writes).toBe(0)
  })

  it('401：记成授权失效', async () => {
    stubFetch(() => new Response('{}', { status: 401 }))
    expect(await refreshPlan()).toEqual({ manifest: null, error: 'unauthorized' })
    expect(planState.unauthorized).toBe(true)
  })

  it('之后拉成功了：清掉授权失效', async () => {
    planState = { ...planState, unauthorized: true }
    stubFetch(() => new Response(JSON.stringify(manifest(spec()))))
    await refreshPlan()
    expect(planState.unauthorized).toBe(false)
  })
})

describe('startCreatorPlanRefresh', () => {
  it('启动后一轮、之后每 6 小时一轮；没连接时每一轮都不发请求', async () => {
    vi.useFakeTimers()
    settings = { version: 3, providers: [mine], roles: {} }
    const fetchImpl = stubFetch(() => new Response('{}'))
    startCreatorPlanRefresh()
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 2)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('已连接：启动后拉一次，6 小时后再拉一次', async () => {
    vi.useFakeTimers()
    const fetchImpl = stubFetch(() => new Response(JSON.stringify(manifest(spec()))))
    startCreatorPlanRefresh()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
