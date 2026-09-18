import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  vaultInfo: {
    id: 'aigc',
    name: 'AIGC',
    path: 'C:/vault/aigc',
    isSystem: true,
    systemKey: 'aigc',
    isCustomLocation: false,
    isActive: true,
    vaultType: 'backup',
    icon: 'sparkles',
    sortOrder: 0,
    assetCount: 0,
    totalSize: 0,
    createdAt: '2026-04-22T00:00:00.000Z',
    updatedAt: '2026-04-22T00:00:00.000Z'
  },
  getVaultBySystemKey: vi.fn()
}))

vi.mock('../sqliteDataBase/VaultManager', () => ({
  SYSTEM_VAULT_KEYS: {
    AIGC: 'aigc'
  },
  VaultType: {
    NETWORK: 'network',
    BACKUP: 'backup'
  },
  VaultManager: {
    getInstance: vi.fn(() => ({
      getVaultBySystemKey: mocks.getVaultBySystemKey
    }))
  }
}))

vi.mock('../sqliteDataBase/models/assetFolder', () => ({
  createAssetFolder: vi.fn(),
  getAssetFolderByKey: vi.fn()
}))

describe('aigcVaultService platform write safety', () => {
  beforeEach(() => {
    mocks.getVaultBySystemKey.mockReset()
    mocks.getVaultBySystemKey.mockReturnValue({ ...mocks.vaultInfo })
  })

  it('allows local writes for the default local AIGC vault', async () => {
    const { assertAIGCVaultLocalWritesAllowed } = await import('./aigcVaultService')

    expect(() => assertAIGCVaultLocalWritesAllowed()).not.toThrow()
  })

  it('blocks local writes when the AIGC vault is an HTTP network vault', async () => {
    const { assertAIGCVaultLocalWritesAllowed } = await import('./aigcVaultService')
    mocks.getVaultBySystemKey.mockReturnValue({
      ...mocks.vaultInfo,
      vaultType: 'network',
      networkPath: 'https://asset-node.example.com'
    })

    expect(() => assertAIGCVaultLocalWritesAllowed()).toThrow('平台网络 AIGC 资产库不允许本地直写')
  })
})
