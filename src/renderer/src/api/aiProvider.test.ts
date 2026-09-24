import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoleBindings, SettingsView } from '@core/shared/aiProvider'
import { aiProviderAPI } from './aiProvider'

const getSettings = vi.fn()
const setRoles = vi.fn()

function settings(roles: RoleBindings = {}): SettingsView {
  return {
    providers: [],
    roles,
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: true
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.api.aiProvider = {
    getSettings,
    setRoles
  } as unknown as typeof window.api.aiProvider
})

describe('aiProviderAPI', () => {
  it('读取输入栏所需的模型设置', async () => {
    const value = settings({ chat: { providerId: 'p', modelId: 'chat' } })
    getSettings.mockResolvedValue(value)

    await expect(aiProviderAPI.getSettings()).resolves.toBe(value)
  })

  it('切换 Agent 只发 agent 这一个（主进程在最新配置上合并，别的角色不动），发的是普通对象', async () => {
    const roles: RoleBindings = {
      chat: { providerId: 'p', modelId: 'chat' },
      vision: { providerId: 'p', modelId: 'vision' }
    }
    setRoles.mockImplementation(async (payload: RoleBindings) => ({
      ok: true,
      data: settings({ ...roles, ...payload })
    }))

    const result = await aiProviderAPI.setAgentRole({
      providerId: 'p2',
      modelId: 'agent::pro'
    })

    const payload = setRoles.mock.calls[0][0] as RoleBindings
    expect(structuredClone(payload)).toEqual({
      agent: { providerId: 'p2', modelId: 'agent::pro' }
    })
    expect(roles.agent).toBeUndefined()
    expect(result.roles.agent).toEqual({ providerId: 'p2', modelId: 'agent::pro' })
  })

  it('主进程拒绝保存时把真实原因交给界面', async () => {
    setRoles.mockResolvedValue({ ok: false, error: 'models.json 只读' })

    await expect(aiProviderAPI.setAgentRole({ providerId: 'p', modelId: 'm' })).rejects.toThrow(
      'models.json 只读'
    )
  })
})
