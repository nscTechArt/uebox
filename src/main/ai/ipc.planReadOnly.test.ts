/** @vitest-environment node */
/**
 * Box Plan 的来源只读：界面上不给编辑、删除入口，主进程再拦一道，
 * 防止绕过界面直接调 IPC 把卡片和配置弄得对不上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderSettings } from './types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
let settings: AiProviderSettings
/** 和真的归一化一样：指向不存在来源的绑定落盘时被丢掉 */
const writeSettings = vi.fn(async (next: AiProviderSettings) => {
  const ids = new Set(next.providers.map((provider) => provider.id))
  settings = {
    ...next,
    roles: Object.fromEntries(
      Object.entries(next.roles).filter(([, binding]) => binding && ids.has(binding.providerId))
    )
  }
  return settings
})
const deleteLiteralKey = vi.fn(async () => {})

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))
vi.mock('./creatorPlan/ipc', () => ({ registerCreatorPlanIPC: () => {} }))
vi.mock('./creatorPlan/refresh', () => ({ startCreatorPlanRefresh: () => {} }))
vi.mock('../ipc/speech', () => ({ registerSpeechIPC: () => {} }))
vi.mock('./catalog', () => ({ PROVIDER_CATALOG: [] }))
vi.mock('./oauth', () => ({
  OAuthCancelledError: class extends Error {},
  runOAuthLogin: vi.fn(),
  yieldsPermanentKey: () => false
}))
vi.mock('./probe', () => ({ listRemoteModels: vi.fn(), testProvider: vi.fn() }))
vi.mock('./resolveModel', () => ({ isLocalModelConfigured: async () => true }))
vi.mock('./credentials', () => ({
  EncryptionUnavailableError: class extends Error {},
  deleteLiteralKey,
  hasApiKey: async () => true,
  isEncryptionAvailable: () => true,
  parseApiKeyInput: () => null,
  saveLiteralKey: vi.fn(),
  saveOAuthTokens: vi.fn()
}))
vi.mock('./store', () => ({
  invalidateSettingsCache: () => {},
  readSettings: async () => settings,
  settingsPath: () => 'models.json',
  writeSettings,
  updateSettings: async (change: (current: typeof settings) => typeof settings) =>
    writeSettings(change(settings))
}))

const { registerAiProviderIPC } = await import('./ipc')
registerAiProviderIPC()

const invoke = (channel: string, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> =>
  handlers.get(channel)!({}, ...args) as Promise<{ ok: boolean; error?: string }>

const plan = {
  id: 'creator-plan',
  displayName: 'Box Plan',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://plan.example/v1',
  apiKey: { kind: 'literal', id: 'creator-plan:key' },
  models: [{ id: 'uebox-agent' }]
} as AiProviderSettings['providers'][number]

beforeEach(() => {
  settings = { version: 3, providers: [plan], roles: {} }
  writeSettings.mockClear()
  deleteLiteralKey.mockClear()
})

describe('套餐来源只读', () => {
  it('save-provider 拒绝改套餐来源，不写盘', async () => {
    const result = await invoke('ai-provider:save-provider', {
      ...plan,
      baseUrl: 'https://evil.example/v1',
      apiKeyInput: ''
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Box Plan')
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('delete-provider 拒绝删套餐来源，也不删共用的 Key', async () => {
    const result = await invoke('ai-provider:delete-provider', 'creator-plan')
    expect(result.ok).toBe(false)
    expect(writeSettings).not.toHaveBeenCalled()
    expect(deleteLiteralKey).not.toHaveBeenCalled()
    expect(settings.providers).toHaveLength(1)
  })

  it('别的来源照常能存', async () => {
    const result = await invoke('ai-provider:save-provider', {
      id: 'mine',
      displayName: 'Mine',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://gw.example/v1',
      models: [{ id: 'gpt-x' }],
      apiKeyInput: ''
    })
    expect(result.ok).toBe(true)
    expect(settings.providers.map((p) => p.id)).toEqual(['creator-plan', 'mine'])
  })
})

/**
 * 改角色只发改了的那几个：主进程在最新配置上合并，null 清空；洗掉不认识的角色和 source；
 * 指向的来源已经不在了（被归一化丢掉）就回 ok:false，不让界面当成存上了
 */
describe('set-roles：按补丁合并', () => {
  const mine = {
    id: 'mine',
    displayName: 'Mine',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: 'https://gw.example/v1',
    apiKey: { kind: 'none' },
    models: [{ id: 'gpt-x' }, { id: 'gpt-y' }]
  } as AiProviderSettings['providers'][number]
  const bind = (modelId: string): { providerId: string; modelId: string } => ({
    providerId: 'mine',
    modelId
  })

  beforeEach(() => {
    settings = {
      version: 3,
      providers: [plan, mine],
      roles: { chat: bind('gpt-x'), summary: bind('gpt-x') }
    }
  })

  it('只改补丁里的角色，别的原样留着；null 清空', async () => {
    const result = await invoke('ai-provider:set-roles', { agent: bind('gpt-y'), summary: null })
    expect(result.ok).toBe(true)
    expect(settings.roles).toEqual({ chat: bind('gpt-x'), agent: bind('gpt-y') })
  })

  it('不认识的角色丢掉，source 洗掉', async () => {
    await invoke('ai-provider:set-roles', {
      agent: { ...bind('gpt-y'), source: 'plan' },
      nonsense: bind('gpt-x')
    })
    expect(settings.roles.agent).toEqual(bind('gpt-y'))
    expect(Object.keys(settings.roles)).not.toContain('nonsense')
  })

  it('指向的来源已经不在了：回 ok:false，别的角色不受影响', async () => {
    const result = await invoke('ai-provider:set-roles', {
      agent: { providerId: 'gone', modelId: 'x' }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('agent')
    expect(settings.roles).toEqual({ chat: bind('gpt-x'), summary: bind('gpt-x') })
  })
})
