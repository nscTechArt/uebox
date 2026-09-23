/** @vitest-environment node */
/**
 * 守的是对社区版的承诺：没连接 Box Plan 时，打开设置页（creator-plan:state）
 * 一个请求都不发。以及：
 * - 导入时记下被接管角色的原绑定，重新导入不覆盖；断开时还原
 * - 断开先在服务端吊销 Key 再删本机的；吊销失败照常断开，回一个标记
 * - 卡片状态走 If-None-Match，304 用缓存；401 记成授权失效
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatorPlanManifest } from '../../../shared/creatorPlan'
import type { AiProviderSettings } from '../types'
import type { PlanState } from './planState'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
let settings: AiProviderSettings
let planState: PlanState
/** 按发生顺序记下「吊销」「删本机 Key」，守先后 */
const log: string[] = []
const openExternal = vi.fn()
/** 设备标识落在这里（deviceId.ts 真读真写） */
const userDataDir = mkdtempSync(join(tmpdir(), 'creator-plan-ipc-'))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => userDataDir },
  shell: { openExternal: (url: string) => openExternal(url) },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

vi.mock('../store', () => ({
  invalidateSettingsCache: () => {},
  readSettings: async () => settings,
  writeSettings: async (next: AiProviderSettings) => {
    settings = next
    return next
  }
}))

vi.mock('../credentials', () => ({
  EncryptionUnavailableError: class extends Error {},
  resolveApiKey: async () => 'ubx-sk-local',
  saveLiteralKey: async (id: string) => ({ kind: 'literal', id }),
  deleteLiteralKey: async (id: string) => {
    log.push(`delete:${id}`)
  }
}))

vi.mock('./planState', () => ({
  readPlanState: async () => planState,
  writePlanState: async (next: PlanState) => {
    planState = next
  },
  updatePlanState: async (patch: Partial<PlanState>) => {
    planState = { ...planState, ...patch }
    return planState
  },
  clearPlanState: async () => {
    planState = empty()
  }
}))

/** 对象存储那一项的挂接：细节在 storage.test.ts，这里只守 IPC 有没有把它接上 */
const storage = {
  planStoragePreview: vi.fn(async () => null as unknown),
  applyPlanStorage: vi.fn(async () => {}),
  /** 还原那一刻 log 里已经有什么：守「吊销之后、删 Key 之前」 */
  restorePlanStorage: vi.fn(async () => {
    restoredAt.push([...log])
  })
}
const restoredAt: string[][] = []
vi.mock('./storage', () => storage)

const { registerCreatorPlanIPC } = await import('./ipc')
const { PLAN_KEY_ID, PLAN_PROVIDER_ID } = await import('./apply')
const { CREATOR_PLAN_KEYS_URL } = await import('./endpoint')
registerCreatorPlanIPC()

const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({}, ...args)

const empty = (): PlanState => ({ originals: {}, etag: null, manifest: null, unauthorized: false })

const chatSpec = (model: string): Record<string, unknown> => ({
  model,
  context_window: 131072,
  max_output_tokens: 16384,
  supports_vision: false,
  supports_video: false,
  supports_tools: true,
  supports_reasoning: false,
  structured_output: 'json-schema'
})

const manifest: CreatorPlanManifest = {
  schema: 1,
  etag: 'p-1',
  plan: {
    product: 'Box Plan',
    tier: 'pro',
    tier_name: 'Pro',
    status: 'active',
    interval: 'month',
    current_period_end: null,
    cancel_at_period_end: false,
    quota_resets_at: null,
    manage_url: 'https://plan.example/account/billing'
  },
  quotas: { text_tokens: { limit: 1000, used: 10 } },
  api: { base_url: 'https://plan.example/v1' },
  roles: { chat: chatSpec('uebox-chat'), agent: chatSpec('uebox-agent') }
}

const mine = {
  id: 'my-gateway',
  displayName: 'My Gateway',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://gw.example/v1',
  apiKey: { kind: 'none' },
  models: [{ id: 'gpt-x' }]
} as AiProviderSettings['providers'][number]

const planProvider = {
  id: PLAN_PROVIDER_ID,
  displayName: 'Box Plan',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://plan.example/v1',
  apiKey: { kind: 'literal', id: PLAN_KEY_ID },
  models: [{ id: 'uebox-chat' }, { id: 'uebox-agent' }]
} as AiProviderSettings['providers'][number]

/** 假 fetch：按 URL 结尾分派，记下每次请求 */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): {
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const route = Object.keys(routes).find((suffix) => String(url).endsWith(suffix))
      if (!route) throw new TypeError('fetch failed')
      if (route === '/auth/revoke') log.push('revoke')
      return routes[route]!()
    })
  )
  return { calls }
}

const ok = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers })

beforeEach(() => {
  log.length = 0
  openExternal.mockClear()
  planState = empty()
  settings = {
    version: 3,
    providers: [mine],
    roles: { chat: { providerId: 'my-gateway', modelId: 'gpt-x' } }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('creator-plan IPC', () => {
  it('没连接：state 直接回「未连接」，不发任何请求', async () => {
    const { calls } = stubFetch({})
    const result = await invoke('creator-plan:state')
    expect(result).toEqual({
      ok: true,
      data: { connected: false, summary: null, managedRoles: [], error: null, deprecations: [] }
    })
    expect(calls).toEqual([])
  })

  it('没预览过就应用：not_connected，不改配置', async () => {
    const before = settings
    const result = (await invoke('creator-plan:apply', ['chat'])) as { ok: boolean; code?: string }
    expect(result).toMatchObject({ ok: false, code: 'not_connected' })
    expect(settings).toBe(before)
  })

  it('连接时带上本机的设备标识；再连一次（断开过、失败过）还是同一个', async () => {
    const { calls } = stubFetch({
      '/v1/connect/device': () => new Response('{}', { status: 503 })
    })
    const deviceIdOf = (index: number): unknown =>
      JSON.parse(String(calls[index]!.init!.body)).device_id

    expect(await invoke('creator-plan:connect')).toMatchObject({ ok: false, code: 'network' })
    await invoke('creator-plan:disconnect')
    expect(await invoke('creator-plan:connect')).toMatchObject({ ok: false, code: 'network' })

    const devices = calls.filter((call) => call.url.endsWith('/v1/connect/device'))
    expect(devices).toHaveLength(2)
    const first = deviceIdOf(calls.indexOf(devices[0]!))
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(deviceIdOf(calls.indexOf(devices[1]!))).toBe(first)
  })
})

describe('导入与断开：原绑定', () => {
  /** 已连接（来源在）、预览拉到清单，再按勾选应用 */
  async function importRoles(roles: string[]): Promise<void> {
    if (!settings.providers.some((p) => p.id === PLAN_PROVIDER_ID)) {
      settings = { ...settings, providers: [...settings.providers, planProvider] }
    }
    stubFetch({ '/plan': () => ok(manifest) })
    expect(await invoke('creator-plan:preview')).toMatchObject({ ok: true })
    expect(await invoke('creator-plan:apply', roles)).toMatchObject({ ok: true })
  }

  it('导入时记下被接管角色的原绑定；原来没设置的记 null', async () => {
    await importRoles(['chat', 'agent'])
    expect(planState.originals).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      agent: null
    })
    expect(settings.roles.chat).toMatchObject({ providerId: PLAN_PROVIDER_ID, source: 'plan' })
  })

  it('重新导入不覆盖最初记下的原绑定', async () => {
    await importRoles(['chat'])
    await importRoles(['chat', 'agent'])
    expect(planState.originals.chat).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
  })

  it('断开：先吊销再删 Key；还在套餐手里的角色还原，原来没设置的回到未设置', async () => {
    await importRoles(['chat', 'agent'])
    const { calls } = stubFetch({ '/auth/revoke': () => new Response(null, { status: 204 }) })

    expect(await invoke('creator-plan:disconnect')).toEqual({
      ok: true,
      data: { revoked: true, keysUrl: CREATOR_PLAN_KEYS_URL }
    })
    expect(log).toEqual(['revoke', `delete:${PLAN_KEY_ID}`])
    expect(calls[0]!.url).toBe('https://plan.example/v1/auth/revoke')
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer ubx-sk-local' }
    })
    expect(settings.providers.map((p) => p.id)).toEqual(['my-gateway'])
    expect(settings.roles).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
    expect(planState).toEqual(empty())
  })

  it('用户导入后手动改过的角色不动；原绑定的来源被删了 → 未设置', async () => {
    const other = { ...mine, id: 'other', models: [{ id: 'm' }] }
    settings = {
      ...settings,
      providers: [mine, other],
      roles: { ...settings.roles, agent: { providerId: 'other', modelId: 'm' } }
    }
    await importRoles(['chat', 'agent'])
    // 之后用户删掉了 agent 原来那个来源，又手动把 chat 改回自己的
    settings = {
      ...settings,
      providers: settings.providers.filter((p) => p.id !== 'other'),
      roles: { ...settings.roles, chat: { providerId: 'my-gateway', modelId: 'gpt-x' } }
    }
    stubFetch({ '/auth/revoke': () => new Response(null, { status: 204 }) })
    await invoke('creator-plan:disconnect')
    expect(settings.roles).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
  })

  it('吊销失败（断网）：照常断开、删本机 Key，回 revoked: false 和网页端地址', async () => {
    await importRoles(['agent'])
    stubFetch({})
    expect(await invoke('creator-plan:disconnect')).toEqual({
      ok: true,
      data: { revoked: false, keysUrl: CREATOR_PLAN_KEYS_URL }
    })
    expect(log).toEqual([`delete:${PLAN_KEY_ID}`])
    expect(settings.providers.map((p) => p.id)).toEqual(['my-gateway'])
  })
})

describe('卡片状态：清单缓存', () => {
  beforeEach(() => {
    settings = {
      ...settings,
      providers: [mine, planProvider],
      roles: {
        ...settings.roles,
        agent: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-agent', source: 'plan' }
      }
    }
  })

  it('带上次的 ETag；304 用缓存的清单', async () => {
    planState = { ...empty(), etag: '"p-1"', manifest }
    const { calls } = stubFetch({ '/plan': () => new Response(null, { status: 304 }) })
    const result = (await invoke('creator-plan:state')) as {
      data: { summary: { tierName: string; quotas: unknown[] }; error: null }
    }
    expect((calls[0]!.init!.headers as Record<string, string>)['if-none-match']).toBe('"p-1"')
    expect(result.data.summary.tierName).toBe('Pro')
    expect(result.data.summary.quotas).toEqual([{ key: 'text_tokens', limit: 1000, used: 10 }])
    expect(result.data.error).toBeNull()
  })

  it('401：标记授权失效，卡片显示 unauthorized', async () => {
    planState = { ...empty(), etag: '"p-1"', manifest }
    stubFetch({ '/plan': () => new Response('{}', { status: 401 }) })
    const result = (await invoke('creator-plan:state')) as { data: { error: string } }
    expect(result.data.error).toBe('unauthorized')
    expect(planState.unauthorized).toBe(true)
  })

  it('清单 deprecations 命中正在用的模型：列出来', async () => {
    const deprecated = {
      ...manifest,
      deprecations: [
        { model: 'uebox-agent', replaced_by: 'uebox-agent-2', removed_at: '2027-03-01T00:00:00Z' },
        { model: 'uebox-embed-v0', replaced_by: 'uebox-embed-v1' }
      ]
    }
    stubFetch({ '/plan': () => ok(deprecated) })
    const result = (await invoke('creator-plan:state')) as { data: { deprecations: unknown } }
    expect(result.data.deprecations).toEqual([
      {
        role: 'agent',
        model: 'uebox-agent',
        replacedBy: 'uebox-agent-2',
        removedAt: '2027-03-01T00:00:00Z'
      }
    ])
  })

  it('open-manage 打开缓存清单里的 manage_url，不发请求', async () => {
    planState = { ...empty(), manifest }
    const { calls } = stubFetch({})
    await invoke('creator-plan:open-manage')
    expect(openExternal).toHaveBeenCalledWith('https://plan.example/account/billing')
    expect(calls).toEqual([])
  })
})

describe('对象存储这一项', () => {
  beforeEach(() => {
    settings = { ...settings, providers: [mine, planProvider] }
    storage.applyPlanStorage.mockClear()
  })

  it('预览带上存储那一行；应用时把勾选原样交下去', async () => {
    const row = { quotaBytes: 1, maxObjectBytes: 1, retentionDays: 30, current: { kind: 'none' } }
    storage.planStoragePreview.mockResolvedValueOnce(row)
    stubFetch({ '/plan': () => ok(manifest) })
    const preview = (await invoke('creator-plan:preview')) as { data: { storage: unknown } }
    expect(preview.data.storage).toEqual(row)
    await invoke('creator-plan:apply', ['chat'], { storage: true })
    expect(storage.applyPlanStorage).toHaveBeenCalledWith(manifest, true)
  })

  it('老的调用方不带第二个参数：交下去的是 undefined（不动对象存储）', async () => {
    stubFetch({ '/plan': () => ok(manifest) })
    await invoke('creator-plan:preview')
    await invoke('creator-plan:apply', ['chat'])
    expect(storage.applyPlanStorage).toHaveBeenCalledWith(manifest, undefined)
  })

  it('断开：删 Key 之前把对象存储还原', async () => {
    stubFetch({ '/auth/revoke': () => new Response(null, { status: 204 }) })
    restoredAt.length = 0
    await invoke('creator-plan:disconnect')
    expect(restoredAt).toEqual([['revoke']])
    expect(log).toEqual(['revoke', `delete:${PLAN_KEY_ID}`])
  })
})
