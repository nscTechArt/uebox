import { describe, expect, it, vi } from 'vitest'
import type { SettingsView } from '@core/shared/aiProvider'
import type { SessionModel } from '@renderer/store/modules/chatSessions'

import { ensureSessionModel, type SessionModelDeps } from './sessionModel'

const settings: SettingsView = {
  providers: [
    {
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'chat',
      protocol: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.5' }],
      apiKey: { kind: 'none' }
    }
  ],
  roles: { agent: { providerId: 'openai', modelId: 'gpt-5.4' } },
  path: '/tmp/models.json',
  encryptionAvailable: true,
  configured: true
}

function deps(initial: {
  model?: SessionModel
  agentSessionId?: string
  saved?: SessionModel | null
  settings?: SettingsView | Error
}): SessionModelDeps & { stored: () => SessionModel | undefined } {
  let model = initial.model
  return {
    stored: () => model,
    chatStore: {
      getModel: () => model,
      setModel: (_id, next) => {
        model = next
      },
      getAgentSessionId: () => initial.agentSessionId ?? ''
    },
    sessionModelOf: vi.fn(async () => initial.saved ?? null),
    getSettings: async () => {
      const value = initial.settings ?? settings
      if (value instanceof Error) throw value
      return value
    }
  }
}

const five = { providerId: 'openai', modelId: 'gpt-5.5' }

describe('ensureSessionModel', () => {
  it('会话上记着的直接用，不看全局', async () => {
    const d = deps({ model: five })
    expect(await ensureSessionModel('c1', d)).toEqual({ model: five, unavailable: false })
    expect(d.sessionModelOf).not.toHaveBeenCalled()
  })

  it('第一轮按全局默认绑定，并记到会话上', async () => {
    const d = deps({})
    const result = await ensureSessionModel('c1', d)
    expect(result.model).toEqual({ providerId: 'openai', modelId: 'gpt-5.4' })
    expect(d.stored()).toEqual({ providerId: 'openai', modelId: 'gpt-5.4' })
  })

  it('会话上没记但主进程执行记录里有（分支、存量会话），认回那一份', async () => {
    const d = deps({ agentSessionId: 'a1', saved: five })
    expect((await ensureSessionModel('c1', d)).model).toEqual(five)
    expect(d.stored()).toEqual(five)
  })

  it('绑定的模型被删了：报不可用，但会话记录不改', async () => {
    const gone = { providerId: 'openai', modelId: 'gpt-4' }
    const d = deps({ model: gone })
    expect(await ensureSessionModel('c1', d)).toEqual({ model: gone, unavailable: true })
    expect(d.stored()).toEqual(gone)
  })

  it('读不到设置也不拦发送', async () => {
    const d = deps({ model: five, settings: new Error('ipc down') })
    expect(await ensureSessionModel('c1', d)).toEqual({ model: five, unavailable: false })
  })
})
