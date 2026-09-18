import { describe, expect, it, vi } from 'vitest'
import type { VaultInfo } from '@renderer/store/modules/vaultStore'
import { AIGC_REFERENCE_LIBRARY_FOLDER_KEY } from '../../../../shared/aigcReferenceLibrary'
import {
  openReferenceLibraryFolder,
  type ReferenceLibraryVaultStore
} from './referenceLibraryNavigation'

const aigcVault = { id: 'aigc-vault', systemKey: 'aigc' } as VaultInfo

function createStore(
  overrides: Partial<ReferenceLibraryVaultStore> = {}
): ReferenceLibraryVaultStore {
  return {
    vaults: [aigcVault],
    currentVault: null,
    loadVaults: vi.fn(),
    switchVault: vi.fn(),
    ...overrides
  }
}

describe('openReferenceLibraryFolder', () => {
  it('switches to the AIGC vault and opens the dedicated reference-material folder', async () => {
    const store = createStore()
    const router = { push: vi.fn() }

    await expect(openReferenceLibraryFolder(store, router)).resolves.toBe(true)

    expect(store.switchVault).toHaveBeenCalledWith(aigcVault.id)
    expect(router.push).toHaveBeenCalledWith({
      path: '/asset-management',
      query: { folderKey: AIGC_REFERENCE_LIBRARY_FOLDER_KEY }
    })
  })

  it('loads vaults before locating the AIGC vault', async () => {
    const store = createStore({ vaults: [] })
    const router = { push: vi.fn() }

    await openReferenceLibraryFolder(store, router)

    expect(store.loadVaults).toHaveBeenCalledOnce()
  })

  it('does not navigate when the AIGC vault is unavailable', async () => {
    const store = createStore({ vaults: [] })
    const router = { push: vi.fn() }

    await expect(openReferenceLibraryFolder(store, router)).resolves.toBe(false)

    expect(store.switchVault).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('preserves failures from loading the vault list for the caller to present', async () => {
    const error = new Error('Vault service unavailable')
    const store = createStore({
      vaults: [],
      loadVaults: vi.fn().mockRejectedValue(error)
    })
    const router = { push: vi.fn() }

    await expect(openReferenceLibraryFolder(store, router)).rejects.toThrow(error)
  })
})
