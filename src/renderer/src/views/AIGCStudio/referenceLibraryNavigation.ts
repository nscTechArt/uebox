import type { Router } from 'vue-router'
import type { VaultInfo } from '@renderer/store/modules/vaultStore'
import { AIGC_REFERENCE_LIBRARY_FOLDER_KEY } from '../../../../shared/aigcReferenceLibrary'

export interface ReferenceLibraryVaultStore {
  vaults: readonly VaultInfo[]
  currentVault: VaultInfo | null
  loadVaults(): Promise<void>
  switchVault(vaultId: string): Promise<void>
}

/**
 * Open the dedicated reference-material folder, not merely the AIGC vault root.
 * This keeps the empty state actionable for a first-time creator.
 */
export async function openReferenceLibraryFolder(
  vaultStore: ReferenceLibraryVaultStore,
  router: Pick<Router, 'push'>
): Promise<boolean> {
  if (vaultStore.vaults.length === 0) {
    await vaultStore.loadVaults()
  }

  const aigcVault = vaultStore.vaults.find((vault) => vault.systemKey === 'aigc')
  if (!aigcVault) return false

  if (vaultStore.currentVault?.id !== aigcVault.id) {
    await vaultStore.switchVault(aigcVault.id)
  }

  await router.push({
    path: '/asset-management',
    query: { folderKey: AIGC_REFERENCE_LIBRARY_FOLDER_KEY }
  })
  return true
}
