/** @vitest-environment node */
/**
 * 守的是对社区版的承诺：没连接 Creator Plan 时，打开设置页（creator-plan:state）
 * 一个请求都不发。以及断开会把来源、绑定、本机 Key 一起清干净。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderSettings } from '../types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
let settings: AiProviderSettings
const deleted: string[] = []

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  shell: { openExternal: vi.fn() },
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
    deleted.push(id)
  }
}))

const { registerCreatorPlanIPC } = await import('./ipc')
const { PLAN_KEY_ID, PLAN_PROVIDER_ID } = await import('./apply')
registerCreatorPlanIPC()

const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({}, ...args)

const mine = {
  id: 'my-gateway',
  displayName: 'My Gateway',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://gw.example/v1',
  apiKey: { kind: 'none' },
  models: [{ id: 'gpt-x' }]
} as AiProviderSettings['providers'][number]

beforeEach(() => {
  deleted.length = 0
  settings = {
    version: 3,
    providers: [mine],
    roles: { chat: { providerId: 'my-gateway', modelId: 'gpt-x' } }
  }
})

describe('creator-plan IPC', () => {
  it('没连接：state 直接回「未连接」，不发任何请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await invoke('creator-plan:state')
    expect(result).toEqual({
      ok: true,
      data: { connected: false, summary: null, managedRoles: [], error: null }
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('没预览过就应用：not_connected，不改配置', async () => {
    const before = settings
    const result = (await invoke('creator-plan:apply', ['chat'])) as { ok: boolean; code?: string }
    expect(result).toMatchObject({ ok: false, code: 'not_connected' })
    expect(settings).toBe(before)
  })

  it('断开：删掉套餐来源和它管着的角色，删掉本机 Key，用户自己的配置留着', async () => {
    settings = {
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
          models: [{ id: 'uebox-agent' }]
        }
      ],
      roles: {
        chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
        agent: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-agent', source: 'plan' }
      }
    }
    expect(await invoke('creator-plan:disconnect')).toEqual({ ok: true, data: null })
    expect(settings.providers.map((p) => p.id)).toEqual(['my-gateway'])
    expect(settings.roles).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
    expect(deleted).toEqual([PLAN_KEY_ID])
  })
})
