/** @vitest-environment node */
/**
 * 同一个账号的第二个来源沿用已有的登录：「Codex 生图」和「Codex」对话是同一个 ChatGPT 账号，
 * 已经登录过的用户添加生图来源时不该再授权一遍。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderSettings } from './types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
let settings: AiProviderSettings
const hasApiKey = vi.fn(async () => true)

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))
vi.mock('./creatorPlan/ipc', () => ({ registerCreatorPlanIPC: () => {} }))
vi.mock('./creatorPlan/refresh', () => ({ startCreatorPlanRefresh: () => {} }))
vi.mock('../ipc/speech', () => ({ registerSpeechIPC: () => {} }))
vi.mock('./oauth', () => ({
  OAuthCancelledError: class extends Error {},
  runOAuthLogin: vi.fn(),
  yieldsPermanentKey: () => false
}))
vi.mock('./probe', () => ({ listRemoteModels: vi.fn(), testProvider: vi.fn() }))
vi.mock('./resolveModel', () => ({ isLocalModelConfigured: async () => true }))
vi.mock('./credentials', () => ({
  EncryptionUnavailableError: class extends Error {},
  deleteLiteralKey: vi.fn(),
  hasApiKey,
  isEncryptionAvailable: () => true,
  parseApiKeyInput: () => null,
  saveLiteralKey: vi.fn(),
  saveOAuthTokens: vi.fn()
}))
vi.mock('./store', () => ({
  invalidateSettingsCache: () => {},
  readSettings: async () => settings,
  settingsPath: () => 'models.json',
  updateSettings: async (change: (current: AiProviderSettings) => AiProviderSettings) =>
    (settings = change(settings))
}))

const { registerAiProviderIPC } = await import('./ipc')
registerAiProviderIPC()

const save = (draft: Record<string, unknown>): Promise<{ ok: boolean }> =>
  handlers.get('ai-provider:save-provider')!({}, draft) as Promise<{ ok: boolean }>

const codexChat = {
  id: 'chatgpt',
  displayName: 'Codex',
  kind: 'chat',
  protocol: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  apiKey: { kind: 'oauth', provider: 'chatgpt', id: 'provider:chatgpt' },
  models: [{ id: 'gpt-6-luna' }]
} as AiProviderSettings['providers'][number]

const imageDraft = {
  id: 'chatgpt-image',
  catalogId: 'chatgpt-image',
  displayName: 'Codex 生图（ChatGPT 订阅）',
  kind: 'image',
  protocol: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  models: [{ id: 'gpt-5.6-luna', imageApi: 'codex-images' }],
  apiKeyInput: ''
}

const savedImageKey = (): unknown =>
  settings.providers.find((provider) => provider.id === 'chatgpt-image')?.apiKey

beforeEach(() => {
  settings = { version: 3, providers: [codexChat], roles: {} }
  hasApiKey.mockResolvedValue(true)
})

describe('沿用同一账号的登录', () => {
  it('已经登录过 Codex 时，生图来源共用那份登录', async () => {
    expect((await save(imageDraft)).ok).toBe(true)
    expect(savedImageKey()).toEqual(codexChat.apiKey)
  })

  it('那份登录已经失效（令牌不在了）就不沿用', async () => {
    hasApiKey.mockResolvedValue(false)
    await save(imageDraft)
    expect(savedImageKey()).toEqual({ kind: 'none' })
  })

  it('不是从目录添加的不沿用：账号认不出来', async () => {
    await save({ ...imageDraft, catalogId: undefined })
    expect(savedImageKey()).toEqual({ kind: 'none' })
  })

  it('别家账号的登录不会被借用', async () => {
    settings.providers = [
      { ...codexChat, id: 'kimi', apiKey: { kind: 'oauth', provider: 'kimi-code', id: 'k' } }
    ]
    await save(imageDraft)
    expect(savedImageKey()).toEqual({ kind: 'none' })
  })
})
